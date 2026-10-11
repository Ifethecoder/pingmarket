/**
 * Public Darwin discovery entry point used by /api/search.
 * Never throws: failures become a `status: "error"` outcome with no capabilities.
 */
import type { DarwinCapabilityResult, DarwinSearchOutcome } from "../types";
import { darwinSearchRaw, type DarwinContextItem, type DarwinRawSearchResponse } from "./client";
import { darwinErrorOutcome, normalizeDarwinResponse } from "./normalize";

export interface DarwinDiscoveryOptions {
  maxPriceCents?: number;
  location?: string;
  marketplaceId?: string;
  maxResults?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface DarwinDiscoveryResult {
  outcome: DarwinSearchOutcome;
  capabilities: DarwinCapabilityResult[];
  /** Raw Darwin response with `searchToken` removed. Persist via `summarizeForPersistence`. */
  raw?: DarwinRawSearchResponse;
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

  const started = Date.now();
  try {
    const raw = await darwinSearchRaw(buildDarwinQuery(query, opts.marketplaceId), {
      maxResults: resolveMaxResults(opts.maxResults),
      context: context.length > 0 ? context : undefined,
      signal: opts.signal,
      fetchImpl: opts.fetchImpl,
    });
    // Private continuation token: never persist or return it to clients.
    delete raw.searchToken;
    const { outcome, capabilities } = normalizeDarwinResponse(raw, Date.now() - started);
    return { outcome, capabilities, raw };
  } catch (err) {
    return { outcome: darwinErrorOutcome(err, Date.now() - started), capabilities: [] };
  }
}

/** Trimmed metadata for `agent_searches.result_metadata`. No searchToken, no connectionPrompt blobs. */
export function summarizeForPersistence(raw: DarwinRawSearchResponse): Record<string, unknown> {
  const r = raw.response;
  return {
    status: raw.status,
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
