/**
 * Search orchestrator (Journey B): native listings + Darwin discovery in parallel,
 * one `agent_searches` audit row per search, merged into the frozen `SearchResponse`.
 *
 * Follow-ups: `req.previousResponseId` must be a `darwin.responseId` this server returned earlier.
 * The private Darwin `searchToken` stored with that row is sent back as `X-Search-Token`
 * and carried forward to the new row (Darwin only issues it on the first response).
 */
import { desc, eq } from "drizzle-orm";
import { getDb, type Db } from "../db";
import { newUuidId } from "../db/ids";
import { agentSearches } from "../db/schema";
import { trackSearch } from "../keewano/track";
import { DARWIN_SKIPPED_OUTCOME } from "../darwin/normalize";
import { runDarwinDiscovery, summarizeForPersistence, type DarwinDiscoveryResult } from "../darwin/search";
import type { SearchRequest, SearchResponse } from "../types";
import { buildSearchResponse } from "./merge";
import { searchNative } from "./native";
import { parseBuyerQuery } from "./query";

export interface RunSearchOptions {
  db?: Db;
  fetchImpl?: typeof fetch;
  /** Simulator only: also return reserved listings so a pending simulated checkout doesn't hide them. */
  includeReserved?: boolean;
}

export type SearchErrorCode = "UNKNOWN_PREVIOUS_RESPONSE";

/** Caller error (maps to HTTP 400), as opposed to a Darwin failure which becomes `darwin.status: "error"`. */
export class SearchError extends Error {
  readonly code: SearchErrorCode;
  constructor(code: SearchErrorCode, message: string) {
    super(message);
    this.name = "SearchError";
    this.code = code;
  }
}

interface Continuation {
  searchToken: string | null;
}

async function findContinuation(conn: Db, previousResponseId: string): Promise<Continuation> {
  const [row] = await conn
    .select({ searchToken: agentSearches.darwinSearchToken })
    .from(agentSearches)
    .where(eq(agentSearches.darwinResponseId, previousResponseId))
    .orderBy(desc(agentSearches.createdAt))
    .limit(1);
  if (!row) {
    throw new SearchError(
      "UNKNOWN_PREVIOUS_RESPONSE",
      "Unknown previousResponseId: it must be the darwin.responseId of an earlier /api/search response from this server.",
    );
  }
  return { searchToken: row.searchToken };
}

export async function runSearch(req: SearchRequest, opts: RunSearchOptions = {}): Promise<SearchResponse> {
  const conn = opts.db ?? (await getDb());
  const parsed = parseBuyerQuery(req.query);
  const maxPriceCents = req.maxPriceCents ?? parsed.maxPriceCents ?? undefined;
  const location = req.location ?? parsed.location ?? undefined;

  // Resolve the follow-up token before anything else so a bad id fails fast with a 400, not a Darwin error.
  const continuation =
    req.previousResponseId && req.includeExternalAgents !== false
      ? await findContinuation(conn, req.previousResponseId)
      : null;

  const darwinPromise: Promise<DarwinDiscoveryResult> =
    req.includeExternalAgents === false
      ? Promise.resolve({ outcome: DARWIN_SKIPPED_OUTCOME, capabilities: [] })
      : runDarwinDiscovery(req.query, {
          maxPriceCents,
          location,
          marketplaceId: req.marketplaceId,
          fetchImpl: opts.fetchImpl,
          ...(continuation
            ? { previousResponseId: req.previousResponseId, searchToken: continuation.searchToken }
            : {}),
        });
  const [native, darwin] = await Promise.all([searchNative(req, conn, { includeReserved: opts.includeReserved }), darwinPromise]);
  const { outcome } = darwin;

  const searchId = newUuidId("as");
  trackSearch(searchId, {
    marketplaceId: req.marketplaceId ?? null,
    nativeCount: native.length,
    darwinStatus: outcome.status,
    externalCount: darwin.capabilities.length,
  });
  try {
    await conn.insert(agentSearches).values({
      id: searchId,
      query: req.query,
      darwinSearchId: outcome.searchId,
      darwinResponseId: outcome.responseId,
      // Follow-ups don't get a fresh token: carry the original forward so the thread can continue.
      darwinSearchToken: darwin.searchToken ?? continuation?.searchToken ?? null,
      status: outcome.status,
      resultMetadata: {
        marketplaceId: req.marketplaceId ?? null,
        previousResponseId: continuation ? (req.previousResponseId ?? null) : null,
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
