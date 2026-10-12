import { and, desc, eq, type SQL } from "drizzle-orm";
import { MAX_PRICE_CENTS } from "../contracts";
import { getDb, type Db } from "../db";
import { nextListingId } from "../db/ids";
import { listings, marketplaces, users, type ListingRow } from "../db/schema";
import { trackListingCreated } from "../keewano/track";
import type { CreateListingInput, Listing, ListingStatus, MarketplaceId } from "../types";

export type ListingErrorCode =
  | "SELLER_NOT_FOUND"
  | "MARKETPLACE_NOT_FOUND"
  | "INVALID_PRICE"
  | "INVALID_CURRENCY";

export class ListingError extends Error {
  constructor(
    public readonly code: ListingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ListingError";
  }
}

export interface ListingFilter {
  marketplaceId?: MarketplaceId;
  status?: ListingStatus;
  sellerId?: string;
}

function toListing(row: ListingRow): Listing {
  return {
    id: row.id,
    marketplaceId: row.marketplaceId,
    sellerId: row.sellerId,
    title: row.title,
    description: row.description,
    priceCents: row.priceCents,
    currency: row.currency,
    location: row.location,
    status: row.status,
    visibility: row.visibility,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Creates an `available` listing with a minted `D{n}` id.
 * Throws `ListingError` on a bad price/currency or an unknown seller/marketplace.
 */
export async function createListing(input: CreateListingInput, db?: Db): Promise<Listing> {
  if (!Number.isInteger(input.priceCents) || input.priceCents <= 0 || input.priceCents > MAX_PRICE_CENTS) {
    throw new ListingError("INVALID_PRICE", `priceCents must be a positive integer <= ${MAX_PRICE_CENTS}`);
  }
  if (input.currency !== undefined && !/^[A-Za-z]{3}$/.test(input.currency)) {
    throw new ListingError("INVALID_CURRENCY", "currency must be a 3-letter code");
  }
  const conn = db ?? (await getDb());
  const [[seller], [marketplace]] = await Promise.all([
    conn.select({ id: users.id }).from(users).where(eq(users.id, input.sellerId)).limit(1),
    conn
      .select({ id: marketplaces.id })
      .from(marketplaces)
      .where(eq(marketplaces.id, input.marketplaceId))
      .limit(1),
  ]);
  if (!seller) throw new ListingError("SELLER_NOT_FOUND", `Seller ${input.sellerId} not found`);
  if (!marketplace) {
    throw new ListingError("MARKETPLACE_NOT_FOUND", `Marketplace ${input.marketplaceId} not found`);
  }
  const id = await nextListingId(conn);
  const [row] = await conn
    .insert(listings)
    .values({
      id,
      sellerId: input.sellerId,
      marketplaceId: input.marketplaceId,
      title: input.title,
      description: input.description ?? null,
      priceCents: input.priceCents,
      currency: input.currency?.toUpperCase() ?? "USD",
      location: input.location ?? null,
      visibility: input.visibility ?? "cross_market",
    })
    .returning();
  const listing = toListing(row);
  trackListingCreated(listing);
  return listing;
}

/** Newest first. */
export async function listListings(filter: ListingFilter = {}, db?: Db): Promise<Listing[]> {
  const conn = db ?? (await getDb());
  const conditions: SQL[] = [];
  if (filter.marketplaceId) conditions.push(eq(listings.marketplaceId, filter.marketplaceId));
  if (filter.status) conditions.push(eq(listings.status, filter.status));
  if (filter.sellerId) conditions.push(eq(listings.sellerId, filter.sellerId));
  const rows = await conn
    .select()
    .from(listings)
    .where(and(...conditions))
    .orderBy(desc(listings.createdAt), desc(listings.id));
  return rows.map(toListing);
}

export async function getListing(id: string, db?: Db): Promise<Listing | null> {
  const conn = db ?? (await getDb());
  const [row] = await conn.select().from(listings).where(eq(listings.id, id)).limit(1);
  return row ? toListing(row) : null;
}

export async function updateListingStatus(
  id: string,
  status: ListingStatus,
  db?: Db,
): Promise<Listing | null> {
  const conn = db ?? (await getDb());
  const [row] = await conn
    .update(listings)
    .set({ status, updatedAt: new Date() })
    .where(eq(listings.id, id))
    .returning();
  return row ? toListing(row) : null;
}
