/**
 * Orders (PM-11): one order per accepted offer, paid only once Stripe's own data confirms the payment
 * (`applyPaidCheckoutSession` in `src/lib/payments/stripe.ts`).
 * Nothing here talks to Stripe; see `src/lib/payments/stripe.ts`.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, type Db } from "../db";
import { nextOrderId } from "../db/ids";
import { listings, offers, orders } from "../db/schema";
import type { Order } from "../types";

export type OrderErrorCode =
  | "OFFER_NOT_FOUND"
  | "OFFER_NOT_ACCEPTED"
  | "ORDER_NOT_FOUND"
  | "ORDER_NOT_PENDING"
  | "ORDER_NOT_PAID"
  | "LISTING_UNAVAILABLE"
  | "PAYMENT_PROCESSING"
  | "SESSION_MISMATCH"
  | "SESSION_NOT_FOUND"
  | "STRIPE_NOT_CONFIGURED"
  | "APP_URL_REQUIRED";

/** HTTP status for each `OrderErrorCode`, shared by the orders/checkout routes. */
export const ORDER_ERROR_STATUS: Record<OrderErrorCode, number> = {
  OFFER_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  OFFER_NOT_ACCEPTED: 409,
  ORDER_NOT_PENDING: 409,
  ORDER_NOT_PAID: 409,
  LISTING_UNAVAILABLE: 409,
  PAYMENT_PROCESSING: 409,
  SESSION_MISMATCH: 409,
  SESSION_NOT_FOUND: 404,
  STRIPE_NOT_CONFIGURED: 503,
  APP_URL_REQUIRED: 503,
};

export class OrderError extends Error {
  constructor(
    public readonly code: OrderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OrderError";
  }
}

type OrderRow = typeof orders.$inferSelect;

export function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    offerId: row.offerId,
    amountCents: row.amountCents,
    paymentStatus: row.paymentStatus,
    stripeCheckoutSessionId: row.stripeCheckoutSessionId,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    stripePaymentIntentId: row.stripePaymentIntentId,
    payoutStatus: row.payoutStatus,
    stripeTransferId: row.stripeTransferId,
    payoutAmountCents: row.payoutAmountCents,
    platformFeeCents: row.platformFeeCents,
    payoutCurrency: row.payoutCurrency,
    payoutError: row.payoutError,
    payoutAt: row.payoutAt ? row.payoutAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Newest first. */
export async function listOrders(db?: Db): Promise<Order[]> {
  const conn = db ?? (await getDb());
  const rows = await conn.select().from(orders).orderBy(desc(orders.createdAt), desc(orders.id));
  return rows.map(toOrder);
}

export async function getOrder(id: string, db?: Db): Promise<Order | null> {
  const conn = db ?? (await getDb());
  const [row] = await conn.select().from(orders).where(eq(orders.id, id)).limit(1);
  return row ? toOrder(row) : null;
}

/**
 * Returns the order for an accepted offer, creating it (`pending`, amount = accepted price) if needed.
 * Idempotent: `orders.offer_id` is unique, so concurrent callers (or Developer A's accept route)
 * converge on one row. Throws `OrderError`.
 */
export async function getOrCreateOrderForOffer(
  offerId: string,
  db?: Db,
): Promise<{ order: Order; created: boolean }> {
  const conn = db ?? (await getDb());
  return conn.transaction(async (tx) => {
    const [offer] = await tx.select().from(offers).where(eq(offers.id, offerId)).limit(1).for("update");
    if (!offer) throw new OrderError("OFFER_NOT_FOUND", `Offer ${offerId} not found`);
    if (offer.status !== "accepted") {
      throw new OrderError("OFFER_NOT_ACCEPTED", `Offer ${offer.id} is ${offer.status}, not accepted`);
    }

    const [existing] = await tx.select().from(orders).where(eq(orders.offerId, offer.id)).limit(1);
    if (existing) return { order: toOrder(existing), created: false };

    const id = await nextOrderId(tx);
    const [inserted] = await tx
      .insert(orders)
      .values({ id, offerId: offer.id, amountCents: offer.proposedPriceCents })
      .onConflictDoNothing({ target: orders.offerId })
      .returning();
    if (inserted) return { order: toOrder(inserted), created: true };

    const [row] = await tx.select().from(orders).where(eq(orders.offerId, offer.id)).limit(1);
    if (!row) throw new Error(`Order insert for offer ${offer.id} conflicted but no existing order was found`);
    return { order: toOrder(row), created: false };
  });
}

/**
 * Compare-and-swap of the order's Checkout Session id: succeeds only while the order is
 * `pending`/`failed` and still holds `expectedPrevious` (null = none). A `failed` order moves back
 * to `pending` (retry). Returns false when another request or a payment confirmation changed the order first.
 */
export async function attachCheckoutSession(
  orderId: string,
  sessionId: string,
  expectedPrevious: string | null,
  db?: Db,
): Promise<boolean> {
  const conn = db ?? (await getDb());
  const rows = await conn
    .update(orders)
    .set({ stripeCheckoutSessionId: sessionId, paymentStatus: "pending" })
    .where(
      and(
        eq(orders.id, orderId),
        inArray(orders.paymentStatus, ["pending", "failed"]),
        sql`${orders.stripeCheckoutSessionId} is not distinct from ${expectedPrevious}::text`,
      ),
    )
    .returning({ id: orders.id });
  return rows.length > 0;
}

interface SessionRef {
  orderId: string;
  sessionId: string;
}

/**
 * The ONLY path to `paid`; called only by `applyPaidCheckoutSession` after it has checked a Checkout
 * Session obtained from Stripe (secret-key retrieve or signed webhook). That session is authoritative,
 * so a `pending`/`failed` order is marked paid and records its id even if a newer session was attached
 * since (the buyer paid an older one). Idempotent: a duplicate
 * delivery returns `changed: false`. An already-paid order with a different session id throws
 * `SESSION_MISMATCH` (possible double payment; logged loudly). Marks the listing `sold` in the same
 * transaction.
 */
export async function markOrderPaid(
  { orderId, sessionId }: SessionRef,
  db?: Db,
): Promise<{ order: Order; changed: boolean }> {
  const conn = db ?? (await getDb());
  return conn.transaction(async (tx) => {
    const [row] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1).for("update");
    if (!row) throw new OrderError("ORDER_NOT_FOUND", `Order ${orderId} not found`);
    if (row.paymentStatus === "paid") {
      if (row.stripeCheckoutSessionId && row.stripeCheckoutSessionId !== sessionId) {
        console.error(
          `[orders] CONFLICT: order ${orderId} already paid with session ${row.stripeCheckoutSessionId}; ` +
            `received a second paid session ${sessionId} (possible double payment, refund manually)`,
        );
        throw new OrderError("SESSION_MISMATCH", `Order ${orderId} is already paid by another session`);
      }
      return { order: toOrder(row), changed: false };
    }

    const [updated] = await tx
      .update(orders)
      .set({ paymentStatus: "paid", stripeCheckoutSessionId: sessionId, paidAt: new Date() })
      .where(eq(orders.id, orderId))
      .returning();

    const [listing] = await tx
      .select({ id: listings.id, status: listings.status })
      .from(offers)
      .innerJoin(listings, eq(offers.listingId, listings.id))
      .where(eq(offers.id, row.offerId))
      .limit(1)
      .for("update", { of: listings });
    if (listing?.status === "sold") {
      console.error(`[orders] CONFLICT: order ${orderId} paid but listing ${listing.id} was already sold`);
    } else if (listing) {
      await tx.update(listings).set({ status: "sold", updatedAt: new Date() }).where(eq(listings.id, listing.id));
    }
    return { order: toOrder(updated), changed: true };
  });
}

/**
 * pending -> failed for an async payment method that failed after Checkout completed. Idempotent.
 * Ignores (`SESSION_MISMATCH`) a failure for a session that is no longer the order's current one.
 */
export async function markOrderPaymentFailed(
  { orderId, sessionId }: SessionRef,
  db?: Db,
): Promise<{ order: Order; changed: boolean }> {
  const conn = db ?? (await getDb());
  return conn.transaction(async (tx) => {
    const [row] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1).for("update");
    if (!row) throw new OrderError("ORDER_NOT_FOUND", `Order ${orderId} not found`);
    if (row.paymentStatus !== "pending") return { order: toOrder(row), changed: false };
    if (row.stripeCheckoutSessionId && row.stripeCheckoutSessionId !== sessionId) {
      throw new OrderError("SESSION_MISMATCH", `Checkout session is not the current one for order ${orderId}`);
    }
    const [updated] = await tx
      .update(orders)
      .set({ paymentStatus: "failed", stripeCheckoutSessionId: sessionId })
      .where(eq(orders.id, orderId))
      .returning();
    return { order: toOrder(updated), changed: true };
  });
}
