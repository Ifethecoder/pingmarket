/**
 * Search orchestrator (Journey B): native listings + Darwin discovery in parallel,
 * one `agent_searches` audit row per search, merged into the frozen `SearchResponse`.
 */
import { getDb, type Db } from "../db";
import { newUuidId } from "../db/ids";
import { agentSearches } from "../db/schema";
import { DARWIN_SKIPPED_OUTCOME } from "../darwin/normalize";
import { runDarwinDiscovery, summarizeForPersistence, type DarwinDiscoveryResult } from "../darwin/search";
import type { SearchRequest, SearchResponse } from "../types";
import { buildSearchResponse } from "./merge";
import { searchNative } from "./native";
import { parseBuyerQuery } from "./query";

export interface RunSearchOptions {
  db?: Db;
  fetchImpl?: typeof fetch;
}

export async function runSearch(req: SearchRequest, opts: RunSearchOptions = {}): Promise<SearchResponse> {
  const conn = opts.db ?? (await getDb());
  const parsed = parseBuyerQuery(req.query);
  const maxPriceCents = req.maxPriceCents ?? parsed.maxPriceCents ?? undefined;
  const location = req.location ?? parsed.location ?? undefined;

  const darwinPromise: Promise<DarwinDiscoveryResult> =
    req.includeExternalAgents === false
      ? Promise.resolve({ outcome: DARWIN_SKIPPED_OUTCOME, capabilities: [] })
      : runDarwinDiscovery(req.query, {
          maxPriceCents,
          location,
          marketplaceId: req.marketplaceId,
          fetchImpl: opts.fetchImpl,
        });
  const [native, darwin] = await Promise.all([searchNative(req, conn), darwinPromise]);
  const { outcome } = darwin;

  try {
    await conn.insert(agentSearches).values({
      id: newUuidId("as"),
      query: req.query,
      darwinSearchId: outcome.searchId,
      darwinResponseId: outcome.responseId,
      status: outcome.status,
      resultMetadata: {
        marketplaceId: req.marketplaceId ?? null,
        nativeCount: native.length,
        nativeIds: native.map((l) => l.id),
        darwin: darwin.raw
          ? summarizeForPersistence(darwin.raw)
          : { status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}) },
      },
    });
  } catch (err) {
    console.error("[search] failed to persist agent_searches row", err);
  }

  return buildSearchResponse(req, native, darwin);
}
