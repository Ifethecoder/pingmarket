/**
 * Low-level Darwin Search v3 client.
 *
 * - Read-only public discovery: POST /api/v3/search.
 * - Lenient response validation so additive Darwin changes don't break us.
 * - `searchToken` is a private continuation token returned on the first (anonymous) response.
 *   Follow-ups send it back in `X-Search-Token` with `previousResponseId`. It is stored server-side
 *   only (`agent_searches.darwin_search_token`) and never returned to browsers.
 */
import { z } from "zod";

export const DARWIN_SEARCH_URL = "https://api.darwin.so/api/v3/search";
export const DARWIN_INDEX_BASE = "https://index.darwin.so";

const DEFAULT_TIMEOUT_MS = 20000;
const RETRY_BACKOFF_MS = 400;

export type DarwinContextItem =
  | { type: "text"; text: string }
  | { type: "budget"; amountMinor: number; currency: "USD" }
  | { type: "deadline"; at: string };

export interface DarwinSearchOptions {
  maxResults?: number;
  agentCount?: "auto" | number;
  /** Continue an earlier response (same Darwin search, new turn). */
  previousResponseId?: string;
  /** Private continuation token from the first response; required for anonymous follow-ups. */
  searchToken?: string | null;
  context?: DarwinContextItem[];
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** `undefined` → fall back to `process.env.DARWIN_API_KEY`; `null` → send no key. */
  apiKey?: string | null;
  baseUrl?: string;
}

export type DarwinErrorCode =
  | "HTTP_ERROR"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "NETWORK"
  | "INVALID_RESPONSE"
  /** Follow-up rejected: expired `previousResponseId` or missing/invalid `X-Search-Token`. */
  | "CONTINUATION_INVALID"
  /** `DARWIN_API_KEY` missing (Act needs an account key). */
  | "NOT_CONFIGURED";

export class DarwinError extends Error {
  readonly code: DarwinErrorCode;
  readonly status?: number;
  readonly details?: unknown;

  constructor(code: DarwinErrorCode, message: string, opts: { status?: number; details?: unknown } = {}) {
    super(message);
    this.name = "DarwinError";
    this.code = code;
    this.status = opts.status;
    this.details = opts.details;
  }
}

// ---------------------------------------------------------------------------
// Lenient response schema
// ---------------------------------------------------------------------------

const optStr = z.string().nullish().catch(null);

const rawConnectionMethodSchema = z.looseObject({
  protocol: optStr,
  environment: optStr,
  endpointUrl: optStr,
  endpointStatus: optStr,
  documentationUrl: optStr,
});

const rawRequiredSetupSchema = z.looseObject({
  kind: optStr,
  suppliedBy: optStr,
  description: optStr,
});

const rawAgentSchema = z.looseObject({
  // Identity fields are required and copied verbatim; an agent without them is unusable.
  agentId: z.string().min(1),
  capabilityId: z.string().min(1),
  rank: z.number(),
  agentSlug: optStr,
  capabilityRevision: z.number().nullish().catch(null),
  selected: z.boolean().nullish().catch(null),
  name: optStr,
  description: optStr,
  imageUrl: optStr,
  avatarUrl: optStr,
  requiredSetup: rawRequiredSetupSchema.nullish().catch(null),
  executionRequirements: z.unknown().optional(),
  executionGuidance: z.unknown().optional(),
  /** Kept as a string so unknown future values don't fail validation. */
  readiness: optStr,
  canStartThread: z.boolean().catch(false),
  canAttemptThread: z.boolean().catch(false),
  reasons: z.array(z.unknown()).catch([]),
  uncertainties: z.array(z.unknown()).catch([]),
  inquiry: z.unknown().optional(),
  providerCheck: optStr,
  connectionMethods: z.array(rawConnectionMethodSchema).catch([]),
  connectionPrompt: optStr,
});

const rawAssessmentSchema = z.looseObject({
  outcome: z.string().catch("unknown"),
  explanation: optStr,
});

const rawRelatedSearchSchema = z.looseObject({
  query: z.string().min(1),
  reason: optStr,
});

const rawSearchResponseSchema = z.looseObject({
  searchId: optStr,
  responseId: optStr,
  previousResponseId: optStr,
  contractVersion: optStr,
  status: z.string(),
  response: z
    .looseObject({
      // Drop individual malformed agents instead of failing the whole response.
      agents: z
        .array(z.unknown())
        .catch([])
        .transform((items) =>
          items.flatMap((item) => {
            const parsed = rawAgentSchema.safeParse(item);
            return parsed.success ? [parsed.data] : [];
          }),
        ),
      assessment: rawAssessmentSchema.nullish().catch(null),
      relatedSearches: z
        .array(z.unknown())
        .catch([])
        .transform((items) =>
          items.flatMap((item) => {
            const parsed = rawRelatedSearchSchema.safeParse(item);
            return parsed.success ? [parsed.data] : [];
          }),
        ),
      plan: z.unknown().optional(),
      question: optStr,
      noMatchReason: optStr,
      overview: optStr,
    })
    .prefault({ agents: [], relatedSearches: [] }),
  searchToken: z.string().optional(),
});

export type DarwinRawSearchResponse = z.output<typeof rawSearchResponseSchema>;
export type DarwinRawAgent = z.output<typeof rawAgentSchema>;

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

function buildBody(query: string, opts: DarwinSearchOptions): Record<string, unknown> {
  // Darwin rejects unknown keys; only include keys that have a value.
  const body: Record<string, unknown> = { query };
  if (opts.maxResults !== undefined) body.maxResults = opts.maxResults;
  if (opts.agentCount !== undefined) body.agentCount = opts.agentCount;
  if (opts.previousResponseId !== undefined) body.previousResponseId = opts.previousResponseId;
  if (opts.context !== undefined && opts.context.length > 0) body.context = opts.context;
  return body;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
}

function errorCodeOf(body: unknown): string | undefined {
  if (body && typeof body === "object" && "code" in body && typeof body.code === "string") return body.code;
  return undefined;
}

export async function darwinSearchRaw(
  query: string,
  opts: DarwinSearchOptions = {},
): Promise<DarwinRawSearchResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = opts.baseUrl ?? DARWIN_SEARCH_URL;
  const apiKey = opts.apiKey === undefined ? process.env.DARWIN_API_KEY : opts.apiKey;
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.DARWIN_SEARCH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  if (opts.searchToken) headers["X-Search-Token"] = opts.searchToken;
  const body = JSON.stringify(buildBody(query, opts));

  const abortError = (): DarwinError =>
    timeoutSignal.aborted
      ? new DarwinError("TIMEOUT", `Darwin Search timed out after ${timeoutMs}ms`)
      : new DarwinError("NETWORK", "Darwin Search request was aborted by the caller");

  let lastError: DarwinError | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      try {
        await sleep(RETRY_BACKOFF_MS, signal);
      } catch {
        throw abortError();
      }
    }

    let res: Response;
    try {
      res = await fetchImpl(url, { method: "POST", headers, body, signal });
    } catch (err) {
      if (signal.aborted) throw abortError();
      lastError = new DarwinError("NETWORK", "Could not reach Darwin Search", {
        details: err instanceof Error ? err.message : String(err),
      });
      continue; // retry once on network errors
    }

    let payload: unknown;
    try {
      payload = await readJson(res);
    } catch (err) {
      if (signal.aborted) throw abortError();
      lastError = new DarwinError("NETWORK", "Darwin Search response body could not be read", {
        status: res.status,
        details: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (res.status === 429) {
      throw new DarwinError("RATE_LIMITED", "Darwin Search rate limit exceeded", { status: 429, details: payload });
    }
    if (res.status >= 500) {
      lastError = new DarwinError("HTTP_ERROR", `Darwin Search returned HTTP ${res.status}`, {
        status: res.status,
        details: payload,
      });
      continue; // retry once on 5xx
    }
    if (!res.ok) {
      const code = errorCodeOf(payload);
      // Observed live: 400 SEARCH_RESPONSE_EXPIRED (stale/unknown previousResponseId), 403 SEARCH_TOKEN_REQUIRED.
      if (
        opts.previousResponseId !== undefined &&
        (code === "SEARCH_RESPONSE_EXPIRED" || code === "SEARCH_TOKEN_REQUIRED" || res.status === 403)
      ) {
        throw new DarwinError(
          "CONTINUATION_INVALID",
          `Darwin Search rejected the follow-up (HTTP ${res.status}${code ? ` ${code}` : ""})`,
          { status: res.status, details: payload },
        );
      }
      throw new DarwinError(
        "HTTP_ERROR",
        `Darwin Search returned HTTP ${res.status}${code ? ` (${code})` : ""}`,
        { status: res.status, details: payload },
      );
    }

    const parsed = rawSearchResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new DarwinError("INVALID_RESPONSE", "Darwin Search returned an unexpected response shape", {
        status: res.status,
        details: z.treeifyError(parsed.error),
      });
    }
    return parsed.data;
  }

  throw lastError ?? new DarwinError("NETWORK", "Darwin Search failed");
}
