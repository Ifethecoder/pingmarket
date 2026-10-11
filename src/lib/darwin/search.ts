/**
 * Public Darwin discovery entry point used by /api/search.
 * Never throws: failures become a `status: "error"` outcome with no capabilities.
 */
import type { DarwinCapabilityResult, DarwinSearchOutcome } from "../types";
import { DarwinError, darwinSearchRaw, type DarwinContextItem, type DarwinRawSearchResponse } from "./client";
import { darwinErrorOutcome, normalizeDarwinResponse } from "./normalize";

export interface DarwinDiscoveryOptions {
  maxPriceCents?: number;
  location?: string;
  marketplaceId?: string;
  maxResults?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /**
   * Follow-up: continue this Darwin response. The query is sent verbatim (no marketplace suffix) because
   * Darwin treats it as the new current task. `searchToken` is the stored token from the first response;
   * anonymous follow-ups are rejected without it.
   */
  previousResponseId?: string;
  searchToken?: string | null;
}

export interface DarwinDiscoveryResult {
  outcome: DarwinSearchOutcome;
  capabilities: DarwinCapabilityResult[];
  /** Raw Darwin response with `searchToken` removed. Persist via `summarizeForPersistence`. */
  raw?: DarwinRawSearchResponse;
  /**
   * Private continuation token (first response of a search only; follow-ups don't return one).
   * Server-side only: persist it for follow-ups, never put it in an HTTP response or the trace.
   */
  searchToken?: string;
}

function marketplaceLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export function buildDarwinQuery(query: string, marketplaceId?: string): string {
  const q = query.trim();
  if (!marketplaceId) return q;
  return `${q} (buyer browsing the ${marketplaceLabel(marketplaceId)} marketplace; looking for a seller/provider agent)`;
}

function resolveMaxResults(requested?: number): number {
  const n = Math.trunc(requested ?? (Number(process.env.DARWIN_SEARCH_MAX_RESULTS) || 5));
  return Math.min(20, Math.max(1, Number.isFinite(n) ? n : 5));
}

export async function runDarwinDiscovery(
  query: string,
  opts: DarwinDiscoveryOptions = {},
): Promise<DarwinDiscoveryResult> {
  const context: DarwinContextItem[] = [];
  if (opts.maxPriceCents !== undefined && Number.isInteger(opts.maxPriceCents) && opts.maxPriceCents > 0) {
    context.push({ type: "budget", amountMinor: opts.maxPriceCents, currency: "USD" });
  }
  const location = opts.location?.trim();
  if (location) context.push({ type: "text", text: `Location: ${location}` });

  const isFollowUp = opts.previousResponseId !== undefined;
  const started = Date.now();
  try {
    const raw = await darwinSearchRaw(isFollowUp ? query.trim() : buildDarwinQuery(query, opts.marketplaceId), {
      maxResults: resolveMaxResults(opts.maxResults),
      context: context.length > 0 ? context : undefined,
      previousResponseId: opts.previousResponseId,
      searchToken: isFollowUp ? opts.searchToken : undefined,
      signal: opts.signal,
      fetchImpl: opts.fetchImpl,
    });
    // Private continuation token: split off for server-side storage; never in `raw`, outcome or trace.
    const searchToken = raw.searchToken;
    delete raw.searchToken;
    const { outcome, capabilities } = normalizeDarwinResponse(raw, Date.now() - started);
    return { outcome, capabilities, raw, ...(searchToken ? { searchToken } : {}) };
  } catch (err) {
    // Server-side breadcrumb only: never log the request body or any token.
    console.warn("[darwin] search failed", {
      code: err instanceof DarwinError ? err.code : undefined,
      status: err instanceof DarwinError ? err.status : undefined,
      message: err instanceof Error ? err.message : String(err),
    });
    return { outcome: darwinErrorOutcome(err, Date.now() - started, opts.previousResponseId ?? null), capabilities: [] };
  }
}

/** Trimmed metadata for `agent_searches.result_metadata`. No searchToken, no connectionPrompt blobs. */
export function summarizeForPersistence(raw: DarwinRawSearchResponse): Record<string, unknown> {
  const r = raw.response;
  return {
    status: raw.status,
    previousResponseId: raw.previousResponseId ?? null,
    assessment: r.assessment ? { outcome: r.assessment.outcome, explanation: r.assessment.explanation ?? null } : null,
    agentCount: r.agents.length,
    agents: r.agents.map((a) => ({
      agentId: a.agentId,
      capabilityId: a.capabilityId,
      capabilityRevision: a.capabilityRevision ?? null,
      rank: a.rank,
      name: a.name ?? null,
      readiness: a.readiness ?? null,
    })),
    question: r.question ?? null,
    noMatchReason: r.noMatchReason ?? null,
  };
}
