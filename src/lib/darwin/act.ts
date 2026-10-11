/**
 * Darwin Act (beta) client: start a thread with an agent from one of our stored searches, then read it back.
 *
 * Safety rules, all enforced here or in the routes:
 * - Needs an account key (`DARWIN_API_KEY`, Search + Act scopes). Server-side only.
 * - Only agents Darwin returned in a search this server ran and persisted can be contacted.
 * - PingMarket only ever sends plain text. It never answers payment, approval, authentication,
 *   or completion requests, so nothing is bought or authorized on anyone's behalf.
 * - A provider reply is shown as the provider said it; PingMarket never treats it as inventory or a quote.
 */
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db";
import { agentSearches } from "../db/schema";
import { DarwinError } from "./client";

export const DARWIN_ACT_URL = "https://api.darwin.so/api/v3/act";
export const DARWIN_ACT_REQUESTS_URL = "https://api.darwin.so/api/v3/act/requests";
const DEFAULT_TIMEOUT_MS = 20000;
export const MAX_ACT_MESSAGE_CHARS = 2000;

// ---------------------------------------------------------------------------
// Public view types (what /api/darwin/act returns to the dashboard)
// ---------------------------------------------------------------------------

export type DarwinActRequestStatus = "pending" | "completed" | "partial" | "failed" | (string & {});

export interface DarwinActMessageView {
  id: string;
  from: "you" | "agent" | "darwin" | (string & {});
  type: "message" | "result" | (string & {});
  /** Text parts joined; non-text parts appear as `[image]`, `[file]`, ... */
  text: string;
  /** Structured result payload, JSON-stringified and truncated. Only on `result` items. */
  data: string | null;
  status: string | null;
  createdAt: string | null;
}

export interface DarwinActPendingRequestView {
  id: string;
  type: string;
  status: string | null;
  /** Plain-language line, including why PingMarket will not answer it. */
  summary: string;
}

export interface DarwinActThreadView {
  agentId: string;
  capabilityId: string | null;
  threadId: string | null;
  errorCode: string | null;
  /** Human explanation of `errorCode`, when we know it. */
  errorExplanation: string | null;
  messages: DarwinActMessageView[];
  actions: { id: string; status: string }[];
  requests: DarwinActPendingRequestView[];
  needsAttention: boolean;
}

export interface DarwinActView {
  actRequestId: string;
  status: DarwinActRequestStatus;
  createdAt: string | null;
  threads: DarwinActThreadView[];
  /** True when polling can stop: request failed, the agent replied, or every action ended. */
  done: boolean;
}

// ---------------------------------------------------------------------------
// Lenient wire schemas (additive Darwin changes must not break us)
// ---------------------------------------------------------------------------

const optStr = z.string().nullish().catch(null);

const rawContentSchema = z.looseObject({ type: z.string().catch("unknown"), text: optStr });

const rawMessageSchema = z.looseObject({
  type: z.string().catch("message"),
  message: z.string().catch(""),
  from: z.string().catch("unknown"),
  content: z.array(rawContentSchema).catch([]),
  status: optStr,
  createdAt: optStr,
  data: z.unknown().optional(),
});

const rawActionSchema = z.looseObject({ action: z.string().catch(""), status: z.string().catch("unknown") });

const rawRequestSchema = z.looseObject({
  type: z.string().catch("unknown"),
  request: z.string().catch(""),
  status: optStr,
  amountMinor: z.union([z.string(), z.number()]).nullish().catch(null),
  currency: optStr,
  payee: z.looseObject({ name: optStr, agent: optStr }).nullish().catch(null),
  reason: optStr,
});

const rawStateSchema = z.looseObject({
  messages: z.array(z.unknown()).catch([]),
  actions: z.array(z.unknown()).catch([]),
  requests: z.array(z.unknown()).catch([]),
  needsAttention: z.boolean().catch(false),
});

const rawThreadSchema = z.looseObject({
  agentId: z.string().min(1),
  capabilityId: optStr,
  threadId: optStr,
  errorCode: optStr,
  state: rawStateSchema.nullish().catch(null),
});

const rawActRequestSchema = z.looseObject({
  actRequestId: z.string().min(1),
  status: z.string().catch("unknown"),
  createdAt: optStr,
  threads: z.array(z.unknown()).catch([]),
});

export type DarwinRawActRequest = z.infer<typeof rawActRequestSchema>;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Error codes observed live (2026-10-11) or documented, in plain language. */
const ERROR_EXPLANATIONS: Record<string, string> = {
  ROUTE_VERIFICATION_EXPIRED:
    "Darwin's verification of this provider's endpoint has expired. Darwin must re-verify the route before anyone can start a thread with it.",
  ROUTE_REVISION_STALE:
    "The capability revision Darwin indexed is out of date with the provider. Darwin needs to re-index it before a thread can start.",
  ACT_SEARCH_AGENT_UNAVAILABLE: "Darwin reports this agent has no approved Act route right now.",
};

export function explainActError(code: string | null | undefined): string | null {
  if (!code) return null;
  return ERROR_EXPLANATIONS[code] ?? null;
}

const TERMINAL_ACTIONS = new Set(["succeeded", "failed", "cancelled", "withdrawn"]);
const MAX_DATA_CHARS = 4000;

function messageText(content: z.infer<typeof rawContentSchema>[]): string {
  return content
    .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
    .filter(Boolean)
    .join("\n");
}

function formatAmount(amountMinor: string | number | null | undefined, currency: string | null | undefined): string {
  const n = Number(amountMinor);
  if (!Number.isFinite(n)) return "an amount";
  return `${(n / 100).toFixed(2)} ${currency ?? ""}`.trim();
}

function summarizeRequest(r: z.infer<typeof rawRequestSchema>): string {
  switch (r.type) {
    case "payment_request": {
      const payee = r.payee?.name ?? r.payee?.agent ?? "the provider";
      return `Provider requested payment of ${formatAmount(r.amountMinor, r.currency)} to ${payee}. PingMarket does not pay external agents.`;
    }
    case "approval_request":
      return `Provider asked for approval${r.reason ? `: ${r.reason}` : ""}. PingMarket does not grant approvals for external agents.`;
    case "authentication_request":
    case "authentication_required":
      return "Provider asked to connect an account. PingMarket does not connect accounts for external agents.";
    case "action_request":
      return "Provider asked to run an action. PingMarket only sends text, so it will not confirm it.";
    case "completion_request":
      return "Provider asked to confirm the task is complete. PingMarket does not confirm completion for external agents.";
    default:
      return `Provider sent a ${r.type} request. PingMarket does not answer it.`;
  }
}

export function normalizeThread(rawThread: unknown): DarwinActThreadView | null {
  const t = rawThreadSchema.safeParse(rawThread);
  if (!t.success) return null;
  const st = t.data.state;
  const messages: DarwinActMessageView[] = [];
  for (const m of st?.messages ?? []) {
    const p = rawMessageSchema.safeParse(m);
    if (!p.success) continue;
    const data =
      p.data.type === "result" && p.data.data !== undefined ? JSON.stringify(p.data.data).slice(0, MAX_DATA_CHARS) : null;
    messages.push({
      id: p.data.message,
      from: p.data.from,
      type: p.data.type,
      text: messageText(p.data.content),
      data,
      status: p.data.status ?? null,
      createdAt: p.data.createdAt ?? null,
    });
  }
  const actions = (st?.actions ?? []).flatMap((a) => {
    const p = rawActionSchema.safeParse(a);
    return p.success ? [{ id: p.data.action, status: p.data.status }] : [];
  });
  const requests = (st?.requests ?? []).flatMap((r) => {
    const p = rawRequestSchema.safeParse(r);
    return p.success ? [{ id: p.data.request, type: p.data.type, status: p.data.status ?? null, summary: summarizeRequest(p.data) }] : [];
  });
  return {
    agentId: t.data.agentId,
    capabilityId: t.data.capabilityId ?? null,
    threadId: t.data.threadId ?? null,
    errorCode: t.data.errorCode ?? null,
    errorExplanation: explainActError(t.data.errorCode),
    messages,
    actions,
    requests,
    needsAttention: st?.needsAttention ?? false,
  };
}

function threadDone(t: DarwinActThreadView): boolean {
  if (t.errorCode) return true;
  if (t.messages.some((m) => m.from === "agent" || m.type === "result")) return true;
  if (t.requests.some((r) => r.status === "pending")) return true; // waiting on something we will never answer
  return t.actions.length > 0 && t.actions.every((a) => TERMINAL_ACTIONS.has(a.status));
}

export function normalizeActRequest(raw: DarwinRawActRequest): DarwinActView {
  const threads = raw.threads.map(normalizeThread).filter((t): t is DarwinActThreadView => t !== null);
  const done = raw.status === "failed" || (threads.length > 0 && threads.every(threadDone));
  return { actRequestId: raw.actRequestId, status: raw.status, createdAt: raw.createdAt ?? null, threads, done };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface DarwinActHttpOptions {
  fetchImpl?: typeof fetch;
  /** `undefined` → `process.env.DARWIN_API_KEY`. */
  apiKey?: string;
  timeoutMs?: number;
}

function resolveKey(opts: DarwinActHttpOptions): string {
  const key = opts.apiKey ?? process.env.DARWIN_API_KEY;
  if (!key) {
    throw new DarwinError("NOT_CONFIGURED", "DARWIN_API_KEY is not set. Darwin Act needs an account key with Search + Act scopes.");
  }
  return key;
}

async function actFetch(url: string, init: RequestInit, opts: DarwinActHttpOptions): Promise<DarwinRawActRequest> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.DARWIN_SEARCH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("x-api-key", resolveKey(opts));

  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw timedOut
      ? new DarwinError("TIMEOUT", `Darwin Act timed out after ${timeoutMs}ms`)
      : new DarwinError("NETWORK", "Could not reach Darwin Act", { details: err instanceof Error ? err.message : String(err) });
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (res.status === 429) throw new DarwinError("RATE_LIMITED", "Darwin Act rate limit exceeded", { status: 429, details: payload });
  if (!res.ok) {
    const code =
      payload && typeof payload === "object" && "code" in payload && typeof payload.code === "string" ? payload.code : undefined;
    throw new DarwinError("HTTP_ERROR", `Darwin Act returned HTTP ${res.status}${code ? ` (${code})` : ""}`, {
      status: res.status,
      details: code ? { code, explanation: explainActError(code) } : payload,
    });
  }
  const parsed = rawActRequestSchema.safeParse(payload);
  if (!parsed.success) {
    throw new DarwinError("INVALID_RESPONSE", "Darwin Act returned an unexpected response shape", {
      status: res.status,
      details: z.treeifyError(parsed.error),
    });
  }
  return parsed.data;
}

/** Direct start of one thread. Darwin rechecks route readiness and authorization before opening it. */
export async function startDarwinAct(
  target: { agentId: string; capabilityId: string },
  message: string,
  opts: DarwinActHttpOptions = {},
): Promise<DarwinActView> {
  const raw = await actFetch(
    DARWIN_ACT_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ targets: [{ agentId: target.agentId, capabilityId: target.capabilityId }], message }),
    },
    opts,
  );
  return normalizeActRequest(raw);
}

export async function getDarwinAct(actRequestId: string, opts: DarwinActHttpOptions = {}): Promise<DarwinActView> {
  const url = `${DARWIN_ACT_REQUESTS_URL}/${encodeURIComponent(actRequestId)}?includeThreadState=true`;
  return normalizeActRequest(await actFetch(url, { method: "GET" }, opts));
}

// ---------------------------------------------------------------------------
// Guard: only agents from a search this server persisted
// ---------------------------------------------------------------------------

const idSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

export const actStartRequestSchema = z.object({
  searchId: z.string().regex(/^srch_[0-9a-f-]{36}$/i, "searchId must be a Darwin srch_ id"),
  agentId: idSchema,
  capabilityId: idSchema,
  message: z.string().trim().min(1).max(MAX_ACT_MESSAGE_CHARS),
});

export type ActStartRequest = z.infer<typeof actStartRequestSchema>;

export const actRequestIdSchema = z.string().regex(/^actreq_[A-Za-z0-9]{8,64}$/, "Not a Darwin actRequestId");

/** True when Darwin returned this exact agent + capability in a search we stored. */
export async function wasReturnedBySearch(
  db: Db,
  searchId: string,
  target: { agentId: string; capabilityId: string },
): Promise<boolean> {
  const rows = await db
    .select({ meta: agentSearches.resultMetadata })
    .from(agentSearches)
    .where(eq(agentSearches.darwinSearchId, searchId))
    .orderBy(desc(agentSearches.createdAt))
    .limit(20);
  return rows.some((row) => {
    const agents = (row.meta?.darwin as { agents?: unknown } | undefined)?.agents;
    return (
      Array.isArray(agents) &&
      agents.some(
        (a) =>
          a && typeof a === "object" && (a as Record<string, unknown>).agentId === target.agentId &&
          (a as Record<string, unknown>).capabilityId === target.capabilityId,
      )
    );
  });
}
