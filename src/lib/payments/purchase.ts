import { and, eq, inArray } from "drizzle-orm";
import { getDb, type Db } from "../db";
import { nextOfferId } from "../db/ids";
import { listings, offers, users } from "../db/schema";
import { toOffer } from "../offers/service";
import { getOrder, getOrCreateOrderForOffer, OrderError } from "../orders/service";
import { notifyTransition } from "../sms/notify";
import { getSimHandset } from "../sms/sim-handsets";
import type { Order } from "../types";
import { getStripe, startCheckout, type Scheduler, type StripeCheckoutClient } from "./stripe";

export type PurchaseErrorCode = "LISTING_NOT_FOUND" | "SELF_PURCHASE" | "UNSUPPORTED_CURRENCY" | "BUYER_NOT_FOUND";
export const PURCHASE_ERROR_STATUS: Record<PurchaseErrorCode, number> = {
  LISTING_NOT_FOUND: 404,
  SELF_PURCHASE: 403,
  UNSUPPORTED_CURRENCY: 400,
  BUYER_NOT_FOUND: 404,
};

export class PurchaseError extends Error {
  constructor(public readonly code: PurchaseErrorCode, message: string) {
    super(message);
    this.name = "PurchaseError";
  }
}

/** Reserves an item for the fixed simulator buyer; only Stripe confirmation records the sale. */
export async function buySimListing(
  listingId: string,
  { origin, client, db, schedule = (task) => task() }: {
    origin: string;
    client?: StripeCheckoutClient;
    db?: Db;
    schedule?: Scheduler;
  },
): Promise<{ order: Order; url: string; sessionId: string }> {
  // Check configuration before touching the listing: missing Stripe must never reserve inventory.
  const stripe = client ?? getStripe();
  const conn = db ?? (await getDb());
  const buyer = await getSimHandset("buyer", conn);
  const result = await conn.transaction(async (tx) => {
    // Same lock order as negotiation and listing edits: listing, then offers.
    const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId)).limit(1).for("update");
    if (!listing) throw new PurchaseError("LISTING_NOT_FOUND", `Listing ${listingId} not found`);
    if (listing.sellerId === buyer.userId) throw new PurchaseError("SELF_PURCHASE", "Sellers cannot buy their own listings");
    if (listing.currency.toUpperCase() !== "USD") {
      throw new PurchaseError("UNSUPPORTED_CURRENCY", "Checkout currently supports USD listings only");
    }
    if (listing.status !== "available" && listing.status !== "reserved") {
      throw new OrderError("LISTING_UNAVAILABLE", `Listing ${listing.id} is ${listing.status}`);
    }
    const accepted = await tx.select().from(offers)
      .where(and(eq(offers.listingId, listing.id), eq(offers.status, "accepted"))).for("update");
    if (accepted.length) {
      if (accepted.length !== 1 || accepted[0].buyerId !== buyer.userId) {
        throw new OrderError("LISTING_UNAVAILABLE", `Listing ${listing.id} is reserved for another buyer`);
      }
      // Preserve the agreed price of an already accepted negotiated offer.
      const offer = toOffer(accepted[0]);
      const { order } = await getOrCreateOrderForOffer(offer.id, tx);
      return { offer, order, declined: [] };
    }
    if (listing.status !== "available") {
      throw new OrderError("LISTING_UNAVAILABLE", `Listing ${listing.id} is reserved for another buyer`);
    }
    const [buyerRow] = await tx.select({ id: users.id }).from(users).where(eq(users.id, buyer.userId)).limit(1);
    if (!buyerRow) throw new PurchaseError("BUYER_NOT_FOUND", "Simulator buyer is not configured");
    const now = new Date();
    const [row] = await tx.insert(offers).values({
      id: await nextOfferId(tx),
      listingId: listing.id,
      sellerId: listing.sellerId,
      buyerId: buyer.userId,
      proposedPriceCents: listing.priceCents,
      status: "accepted",
      lastActorId: buyer.userId,
      source: "web_simulated",
      expiresAt: null,
    }).returning();
    await tx.update(listings).set({ status: "reserved", updatedAt: now }).where(eq(listings.id, listing.id));
    const declined = await tx.update(offers)
      .set({ status: "declined", lastActorId: listing.sellerId, updatedAt: now })
      .where(and(eq(offers.listingId, listing.id), inArray(offers.status, ["open", "countered"]))).returning();
    const offer = toOffer(row);
    const { order } = await getOrCreateOrderForOffer(offer.id, tx);
    return { offer, order, declined: declined.map(toOffer) };
  });
  if (result.declined.length) {
    await schedule(() => notifyTransition({
      offer: result.offer,
      actorId: buyer.userId,
      declined: result.declined,
      counterpart: false,
    }, conn));
  }
  const { url, sessionId } = await startCheckout(result.order.id, {
    origin, client: stripe, db: conn, schedule, returnPath: "/sim",
  });
  return { order: (await getOrder(result.order.id, conn)) ?? result.order, url, sessionId };
}
