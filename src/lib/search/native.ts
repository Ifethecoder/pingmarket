/**
 * Native PingMarket listing search (PM-05). Deterministic scoring, no LLM.
 * Candidate set: available listings visible from the buyer's marketplace
 * (own marketplace + `cross_market` listings from other marketplaces).
 */
import { and, eq, or } from "drizzle-orm";
import { getDb, type Db } from "../db";
import { listings, marketplaces, type ListingRow } from "../db/schema";
import type { NativeListingResult, SearchRequest } from "../types";
import { parseBuyerQuery } from "./query";

const TITLE_WEIGHT = 3;
const DESCRIPTION_WEIGHT = 1;
const MARKETPLACE_WEIGHT = 1;
const LOCATION_WEIGHT = 2;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary, case-insensitive; also matches the plural `token + "s"`. */
function containsToken(text: string | null, token: string): boolean {
  if (!text) return false;
  return new RegExp(String.raw`\b${escapeRegExp(token)}s?\b`, "i").test(text);
}

function formatBudget(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars.toLocaleString("en-US")}` : `$${dollars.toFixed(2)}`;
}

function sameLocation(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export async function searchNative(req: SearchRequest, db?: Db): Promise<NativeListingResult[]> {
  const conn = db ?? (await getDb());
  const parsed = parseBuyerQuery(req.query);
  const maxPriceCents = req.maxPriceCents ?? parsed.maxPriceCents;
  const location = req.location ?? parsed.location;

  const visibility = req.marketplaceId
    ? or(eq(listings.marketplaceId, req.marketplaceId), eq(listings.visibility, "cross_market"))
    : undefined;
  const [rows, markets] = await Promise.all([
    conn.select().from(listings).where(and(eq(listings.status, "available"), visibility)),
    conn.select().from(marketplaces),
  ]);
  const marketById = new Map(markets.map((m) => [m.id, m]));

  const scored: Array<{ row: ListingRow; score: number; result: NativeListingResult }> = [];
  for (const row of rows) {
    if (maxPriceCents != null && row.priceCents > maxPriceCents) continue;
    if (location && row.location && !sameLocation(row.location, location)) continue;

    const market = marketById.get(row.marketplaceId);
    const reasons: string[] = [];
    let textScore = 0;
    for (const token of parsed.tokens) {
      const inTitle = containsToken(row.title, token);
      const inDescription = containsToken(row.description, token);
      if (inTitle) {
        textScore += TITLE_WEIGHT;
        reasons.push(`Title matches "${token}"`);
      }
      if (inDescription) {
        textScore += DESCRIPTION_WEIGHT;
        if (!inTitle) reasons.push(`Description mentions "${token}"`);
      }
      if (market && (containsToken(market.category, token) || containsToken(market.name, token))) {
        textScore += MARKETPLACE_WEIGHT;
        reasons.push(`Marketplace matches "${token}"`);
      }
    }
    if (parsed.tokens.length > 0 && textScore === 0) continue;

    let score = textScore;
    if (maxPriceCents != null) reasons.push(`Under ${formatBudget(maxPriceCents)} budget`);
    if (location && row.location) {
      score += LOCATION_WEIGHT;
      reasons.push(`Located in ${row.location}`);
    }
    const crossMarket = req.marketplaceId !== undefined && row.marketplaceId !== req.marketplaceId;
    if (crossMarket) reasons.push(`Cross-market result from ${market?.name ?? row.marketplaceId}`);

    scored.push({
      row,
      score,
      result: {
        type: "native_listing",
        id: row.id,
        marketplaceId: row.marketplaceId,
        title: row.title,
        description: row.description,
        priceCents: row.priceCents,
        currency: row.currency,
        location: row.location,
        status: row.status,
        crossMarket,
        matchReasons: reasons,
      },
    });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(a.result.crossMarket) - Number(b.result.crossMarket) ||
      a.row.priceCents - b.row.priceCents ||
      a.row.id.localeCompare(b.row.id, "en", { numeric: true }),
  );
  return scored.map((s) => s.result);
}
