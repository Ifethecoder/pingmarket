/**
 * Offer negotiation (counter / accept / decline) over drizzle.
 *
 * Same business rules as Developer A's store-based state machine in `./service.ts`, implemented
 * directly with database transactions: lock the listing, then the offer (FOR UPDATE), validate, write.
 * The actor id always comes from trusted server context (dashboard route or the phone → user mapping),
 * never from a request body or SMS text.
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import { MAX_PRICE_CENTS } from "../contracts";
import { getDb, type Db } from "../db";
import { listings, offers, type ListingRow } from "../db/schema";
import { trackOfferTransition } from "../keewano/track";
import { toOffer } from "../offers/service";
import { getOrCreateOrderForOffer } from "../orders/service";
import type { NegotiationPort } from "../sms/gateway";
import type { Offer } from "../types";

export type NegotiationErrorCode =
  | "OFFER_NOT_FOUND"
  | "OFFER_CLOSED"
  | "OFFER_EXPIRED"
  | "FORBIDDEN"
  | "INVALID_PRICE"
  | "LISTING_UNAVAILABLE"
  | "SMS_BUYER_ONLY";

export const NEGOTIATION_ERROR_STATUS: Record<NegotiationErrorCode, number> = {
  OFFER_NOT_FOUND: 404,
  OFFER_CLOSED: 409,
  OFFER_EXPIRED: 409,
  FORBIDDEN: 403,
  INVALID_PRICE: 400,
  LISTING_UNAVAILABLE: 409,
  SMS_BUYER_ONLY: 409,
};

/** Messages are short and human-readable: the SMS gateway texts them back verbatim. */
export class NegotiationError extends Error {
  constructor(
    public readonly code: NegotiationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NegotiationError";
  }
}

type Action = "counter" | "accept" | "decline";

/** Same lifetime as a new offer (`createOffer`): a counter restarts the clock for the buyer. */
const OFFER_TTL_MS = 24 * 60 * 60 * 1000;

export interface NegotiationOutcome {
  offer: Offer;
  /** False when the call was an idempotent repeat (nothing written): callers must not notify again. */
  changed: boolean;
  /** Competing open/countered offers on the listing that this accept declined. */
  declined: Offer[];
}

interface TransitionInput {
  offerId: string;
  actorId: string;
  priceCents?: number;
}

async function transition(action: Action, input: TransitionInput, db?: Db): Promise<NegotiationOutcome> {
  if (
    action === "counter" &&
    (!Number.isInteger(input.priceCents) || input.priceCents! <= 0 || input.priceCents! > MAX_PRICE_CENTS)
  ) {
    throw new NegotiationError("INVALID_PRICE", `Counter price must be a positive whole number of cents <= ${MAX_PRICE_CENTS}.`);
  }
  const conn = db ?? (await getDb());
  let listingRow: ListingRow | undefined;
  const outcome = await conn.transaction(async (tx) => {
    // Lock order: listing first, then offer (same order as createOffer and seller edits).
    const [ref] = await tx.select({ listingId: offers.listingId }).from(offers).where(eq(offers.id, input.offerId)).limit(1);
    if (!ref) throw new NegotiationError("OFFER_NOT_FOUND", `No offer ${input.offerId}.`);
    const [listing] = await tx.select().from(listings).where(eq(listings.id, ref.listingId)).limit(1).for("update");
    const [offer] = await tx.select().from(offers).where(eq(offers.id, input.offerId)).limit(1).for("update");
    if (!offer || !listing) throw new NegotiationError("OFFER_NOT_FOUND", `No offer ${input.offerId}.`);
    listingRow = listing;

    const { actorId } = input;
    if (actorId !== offer.buyerId && actorId !== offer.sellerId) {
      throw new NegotiationError("FORBIDDEN", `Offer ${offer.id} isn't yours.`);
    }
    // A repeated accept / decline by the party who made it returns the committed offer unchanged
    // (an accepted offer keeps its single order).
    if (action === "accept" && offer.status === "accepted" && offer.lastActorId === actorId) {
      await getOrCreateOrderForOffer(offer.id, tx);
      return { offer: toOffer(offer), changed: false, declined: [] };
    }
    if (action === "decline" && offer.status === "declined" && offer.lastActorId === actorId) {
      return { offer: toOffer(offer), changed: false, declined: [] };
    }
    if (offer.status !== "open" && offer.status !== "countered") {
      throw new NegotiationError("OFFER_CLOSED", `Offer ${offer.id} is already ${offer.status}.`);
    }
    const now = new Date();
    if (offer.expiresAt && offer.expiresAt.getTime() <= now.getTime()) {
      throw new NegotiationError("OFFER_EXPIRED", `Offer ${offer.id} has expired.`);
    }
    const recipient = offer.lastActorId === offer.buyerId ? offer.sellerId : offer.buyerId;
    if (actorId !== recipient) {
      throw new NegotiationError("FORBIDDEN", `Offer ${offer.id} is waiting on the other party.`);
    }

    if (action === "counter") {
      if (actorId !== offer.sellerId || offer.status !== "open") {
        throw new NegotiationError("FORBIDDEN", `Only the seller can counter an open offer.`);
      }
      if (listing.status !== "available") {
        throw new NegotiationError("LISTING_UNAVAILABLE", `${listing.id} is ${listing.status}.`);
      }
      const [row] = await tx
        .update(offers)
        .set({
          proposedPriceCents: input.priceCents!,
          status: "countered",
          lastActorId: actorId,
          expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
          updatedAt: now,
        })
        .where(eq(offers.id, offer.id))
        .returning();
      return { offer: toOffer(row), changed: true, declined: [] };
    }

    if (action === "decline") {
      const [row] = await tx
        .update(offers)
        .set({ status: "declined", lastActorId: actorId, updatedAt: now })
        .where(eq(offers.id, offer.id))
        .returning();
      return { offer: toOffer(row), changed: true, declined: [] };
    }

    if (listing.status !== "available") {
      throw new NegotiationError("LISTING_UNAVAILABLE", `${listing.id} is ${listing.status}.`);
    }
    const [row] = await tx
      .update(offers)
      .set({ status: "accepted", lastActorId: actorId, updatedAt: now })
      .where(eq(offers.id, offer.id))
      .returning();
    await tx.update(listings).set({ status: "reserved", updatedAt: now }).where(eq(listings.id, listing.id));
    // Competing offers are declined on the seller's behalf (the listing is now reserved).
    const declined = await tx
      .update(offers)
      .set({ status: "declined", lastActorId: listing.sellerId, updatedAt: now })
      .where(and(eq(offers.listingId, listing.id), ne(offers.id, offer.id), inArray(offers.status, ["open", "countered"])))
      .returning();
    await getOrCreateOrderForOffer(offer.id, tx);
    return { offer: toOffer(row), changed: true, declined: declined.map(toOffer) };
  });
  if (outcome.changed && listingRow) {
    const listing = { ...listingRow, createdAt: listingRow.createdAt.toISOString() };
    trackOfferTransition(outcome.offer, listing, input.actorId, outcome.declined);
  }
  return outcome;
}

/** Seller counters an `open` offer: new proposed price, status `countered`. Throws `NegotiationError`. */
export function counterOffer(input: { offerId: string; actorId: string; priceCents: number }, db?: Db): Promise<NegotiationOutcome> {
  return transition("counter", input, db);
}

/**
 * The party the offer is waiting on accepts it: offer `accepted`, listing `reserved`, competing offers
 * `declined`, and one `pending` order created, all in one transaction. Throws `NegotiationError`.
 */
export function acceptOffer(input: { offerId: string; actorId: string }, db?: Db): Promise<NegotiationOutcome> {
  return transition("accept", input, db);
}

/** The party the offer is waiting on declines it. Throws `NegotiationError`. */
export function declineOffer(input: { offerId: string; actorId: string }, db?: Db): Promise<NegotiationOutcome> {
  return transition("decline", input, db);
}

/** Drizzle-backed negotiation shared by the /sim handsets and the real Dial buyer. */
export const dbNegotiation: NegotiationPort = {
  counter: (input, db) => counterOffer(input, db),
  accept: (input, db) => acceptOffer(input, db),
  decline: (input, db) => declineOffer(input, db),
};
