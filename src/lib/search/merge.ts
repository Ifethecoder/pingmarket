/**
 * Merges native listings and Darwin capabilities into the frozen `SearchResponse` (PM-07).
 * Pure: no fabricated fields, no confidence scores; Darwin's outcome is passed through verbatim.
 */
import type {
  DarwinCapabilityResult,
  DarwinSearchOutcome,
  NativeListingResult,
  SearchRequest,
  SearchResponse,
} from "../types";

export function buildSearchResponse(
  req: SearchRequest,
  native: NativeListingResult[],
  darwin: { outcome: DarwinSearchOutcome; capabilities: DarwinCapabilityResult[] },
): SearchResponse {
  return {
    query: req.query,
    marketplaceId: req.marketplaceId ?? null,
    nativeListings: native,
    externalCapabilities: [...darwin.capabilities].sort((a, b) => a.rank - b.rank),
    darwin: darwin.outcome,
  };
}

/** One-line trace summary, e.g. `2 native (1 cross-market) · Darwin completed: 3 capabilities`. */
export function describeSearchForTrace(resp: SearchResponse): string {
  const crossCount = resp.nativeListings.filter((l) => l.crossMarket).length;
  const native = `${resp.nativeListings.length} native${crossCount > 0 ? ` (${crossCount} cross-market)` : ""}`;
  const { status, error } = resp.darwin;
  let darwin: string;
  if (status === "completed") {
    const n = resp.externalCapabilities.length;
    darwin = `Darwin completed: ${n} ${n === 1 ? "capability" : "capabilities"}`;
  } else if (status === "error") {
    darwin = `Darwin error: ${error ?? "unknown error"}`;
  } else {
    darwin = `Darwin ${status}`;
  }
  return `${native} · ${darwin}`;
}
