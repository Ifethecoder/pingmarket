/**
 * /sim only: shape SMS search results into the buyer simulator's catalog.
 *
 * The simulated seller re-lists the same item many times, so a search would show identical
 * products. Here every result stands in for a different seller's product: listings the sim buyer
 * cannot purchase are dropped, and repeated listings get their own price. The price set here is
 * the one BUY charges through Stripe, so SEARCH and checkout always agree.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { offers } from "../db/schema";
import type { NativeListingResult } from "../types";

/** Discounts for listings other than the newest one, picked by listing number so a price never drifts. */
const SIM_PRICE_FACTORS = [0.9, 0.8, 0.85, 0.75, 0.95] as const;

function listingNumber(id: string): number {
  return Number(/(\d+)$/.exec(id)?.[1] ?? 0);
}

export function simPriceCents(listing: NativeListingResult, newestId: string | undefined): number {
  if (listing.id === newestId) return listing.priceCents;
  const factor = SIM_PRICE_FACTORS[listingNumber(listing.id) % SIM_PRICE_FACTORS.length];
  return Math.max(100, Math.round((listing.priceCents * factor) / 100) * 100);
}

export async function simCatalog(
  listings: NativeListingResult[],
  buyerId: string,
  db: Db,
): Promise<NativeListingResult[]> {
  const reservedIds = listings.filter((l) => l.status === "reserved").map((l) => l.id);
  const held = reservedIds.length
    ? await db.select({
      listingId: offers.listingId,
      buyerId: offers.buyerId,
      priceCents: offers.proposedPriceCents,
      source: offers.source,
    })
      .from(offers)
      .where(and(inArray(offers.listingId, reservedIds), eq(offers.status, "accepted")))
    : [];
  // Reserved listings are buyable only when reserved for this buyer. A negotiated price is kept;
  // a plain BUY reservation (`web_simulated`) follows the catalog price, and BUY re-prices its order.
  const mineHeld = held.filter((o) => o.buyerId === buyerId);
  const mine = new Set(mineHeld.map((o) => o.listingId));
  const negotiated = new Map(mineHeld.filter((o) => o.source !== "web_simulated").map((o) => [o.listingId, o.priceCents]));
  const buyable = listings.filter((l) => l.status === "available" || mine.has(l.id));
  const newestId = buyable
    .filter((l) => l.status === "available")
    .reduce<NativeListingResult | undefined>((a, b) => (!a || listingNumber(b.id) > listingNumber(a.id) ? b : a), undefined)?.id;
  return buyable.map((l) => ({ ...l, priceCents: negotiated.get(l.id) ?? simPriceCents(l, newestId) }));
}
