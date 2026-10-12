import { and, desc, eq, type SQL } from "drizzle-orm";
import { MAX_PRICE_CENTS } from "../contracts";
import { getDb, type Db } from "../db";
import { nextOfferId } from "../db/ids";
import { listings, offers, users, type OfferRow } from "../db/schema";
import { trackOfferCreated } from "../keewano/track";
import type { CreateOfferRequest, Offer, OfferStatus } from "../types";

/** Seeded dashboard buyer used when `buyerId` is omitted. */
export const WEB_BUYER_ID = "u_web_buyer";
const OFFER_TTL_MS = 24 * 60 * 60 * 1000;

export type OfferErrorCode =
  | "LISTING_NOT_FOUND"
  | "LISTING_UNAVAILABLE"
  | "INVALID_PRICE"
  | "BUYER_NOT_FOUND"
  | "SELF_OFFER";

export class OfferError extends Error {
  constructor(
    public readonly code: OfferErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OfferError";
  }
}

export interface OfferFilter {
  listingId?: string;
  status?: OfferStatus;
}

export function toOffer(row: OfferRow): Offer {
  return {
    id: row.id,
    listingId: row.listingId,
    buyerId: row.buyerId,
    sellerId: row.sellerId,
    proposedPriceCents: row.proposedPriceCents,
    status: row.status,
    lastActorId: row.lastActorId,
    source: row.source,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Creates an `open` buyer offer (id `O{n}`, expires in 24h) on an available listing. Throws `OfferError`. */
export async function createOffer(input: CreateOfferRequest, db?: Db): Promise<Offer> {
  if (!Number.isInteger(input.priceCents) || input.priceCents <= 0 || input.priceCents > MAX_PRICE_CENTS) {
    throw new OfferError("INVALID_PRICE", `priceCents must be a positive integer <= ${MAX_PRICE_CENTS}`);
  }
  const conn = db ?? (await getDb());
  const buyerId = input.buyerId ?? WEB_BUYER_ID;
  const source = input.source ?? "web_simulated";

  // Lock the listing row so a concurrent status change (sold/reserved) cannot interleave
  // between the availability check and the insert.
  const { offer, listing } = await conn.transaction(async (tx) => {
    const [listing] = await tx
      .select()
      .from(listings)
      .where(eq(listings.id, input.listingId))
      .limit(1)
      .for("update");
    if (!listing) {
      throw new OfferError("LISTING_NOT_FOUND", `Listing ${input.listingId} not found`);
    }
    if (listing.status !== "available") {
      throw new OfferError("LISTING_UNAVAILABLE", `Listing ${listing.id} is ${listing.status}`);
    }
    if (listing.sellerId === buyerId) {
      throw new OfferError("SELF_OFFER", "Sellers cannot make offers on their own listings");
    }
    const [buyer] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, buyerId))
      .limit(1);
    if (!buyer) {
      throw new OfferError("BUYER_NOT_FOUND", `Buyer ${buyerId} not found`);
    }

    const id = await nextOfferId(tx);
    const [row] = await tx
      .insert(offers)
      .values({
        id,
        listingId: listing.id,
        buyerId,
        sellerId: listing.sellerId,
        proposedPriceCents: input.priceCents,
        status: "open",
        lastActorId: buyerId,
        source,
        expiresAt: new Date(Date.now() + OFFER_TTL_MS),
      })
      .returning();
    return { offer: toOffer(row), listing };
  });
  trackOfferCreated(offer, { ...listing, createdAt: listing.createdAt.toISOString() });
  return offer;
}

/** Newest first. */
export async function listOffers(filter: OfferFilter = {}, db?: Db): Promise<Offer[]> {
  const conn = db ?? (await getDb());
  const conditions: SQL[] = [];
  if (filter.listingId) conditions.push(eq(offers.listingId, filter.listingId));
  if (filter.status) conditions.push(eq(offers.status, filter.status));
  const rows = await conn
    .select()
    .from(offers)
    .where(and(...conditions))
    .orderBy(desc(offers.createdAt), desc(offers.id));
  return rows.map(toOffer);
}

export async function getOffer(id: string, db?: Db): Promise<Offer | null> {
  const conn = db ?? (await getDb());
  const [row] = await conn.select().from(offers).where(eq(offers.id, id)).limit(1);
  return row ? toOffer(row) : null;
}
