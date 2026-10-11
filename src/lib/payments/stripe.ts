/**
 * Stripe test-mode Checkout (PM-11). All Stripe-specific code lives here.
 * Hosted Checkout only: card details never touch PingMarket. No Connect, no payouts.
 * An order becomes `paid` only via the signed webhook (`verifyStripeWebhook` -> `markOrderPaid`).
 */
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { getDb, type Db } from "../db";
import { listings, offers } from "../db/schema";
import { attachCheckoutSession, getOrder, OrderError } from "../orders/service";
import type { Order } from "../types";

/** The slice of the Stripe client used here; tests inject a fake. */
export interface StripeCheckoutClient {
  checkout: {
    sessions: {
      create(params: Stripe.Checkout.SessionCreateParams): Promise<Pick<Stripe.Checkout.Session, "id" | "url">>;
      retrieve(id: string): Promise<Pick<Stripe.Checkout.Session, "id" | "url" | "status">>;
      expire(id: string): Promise<Pick<Stripe.Checkout.Session, "id" | "status">>;
    };
  };
}

let client: Stripe | null = null;

/** True when `STRIPE_SECRET_KEY` holds a test-mode key. Live keys are refused (test mode only). */
export function isStripeConfigured(): boolean {
  const key = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  return key.startsWith("sk_test_") || key.startsWith("rk_test_");
}

/** Lazy, memoized client so importing this module never requires the key (e.g. during `next build`). */
export function getStripe(): Stripe {
  if (!isStripeConfigured()) {
    throw new OrderError("STRIPE_NOT_CONFIGURED", "Stripe not configured (set STRIPE_SECRET_KEY to a test-mode key)");
  }
  client ??= new Stripe(process.env.STRIPE_SECRET_KEY!.trim());
  return client;
}

export interface CheckoutOptions {
  /** Absolute app origin for the return URLs, e.g. `http://localhost:3000`. */
  origin: string;
  /** Line item name; defaults to `PingMarket order {id} (offer {offerId})`. */
  productName?: string;
  client?: StripeCheckoutClient;
}

/** Creates a hosted test-mode Checkout Session for one order. Does not touch the database. */
export async function createCheckoutSessionForOrder(
  order: Order,
  { origin, productName, client: injected }: CheckoutOptions,
): Promise<{ id: string; url: string }> {
  const stripe = injected ?? getStripe();
  const back = (result: "success" | "cancel") =>
    `${origin}/dashboard?checkout=${result}&order=${encodeURIComponent(order.id)}`;
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: order.amountCents,
          product_data: { name: productName ?? `PingMarket order ${order.id} (offer ${order.offerId})` },
        },
      },
    ],
    client_reference_id: order.id,
    metadata: { orderId: order.id, offerId: order.offerId },
    success_url: back("success"),
    cancel_url: back("cancel"),
  });
  if (!session.url) throw new Error(`Stripe returned no Checkout URL for session ${session.id}`);
  return { id: session.id, url: session.url };
}

type StoredSession = Pick<Stripe.Checkout.Session, "id" | "url" | "status">;

function isResourceMissing(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeInvalidRequestError && err.code === "resource_missing";
}

function paymentProcessing(orderId: string): OrderError {
  return new OrderError("PAYMENT_PROCESSING", `Payment for order ${orderId} received; awaiting webhook confirmation`);
}

/**
 * Returns a Checkout URL for a `pending` (or `failed`, to retry) order. The stored session is:
 * reused while `open`; never replaced once `complete` (paid, webhook pending -> `PAYMENT_PROCESSING`);
 * replaced when `expired` or missing on Stripe; expired first in any other state. The new session id
 * is stored with a compare-and-swap, so concurrent clicks converge on one session.
 * Throws `OrderError` (`STRIPE_NOT_CONFIGURED`, `ORDER_NOT_FOUND`, `ORDER_NOT_PENDING`,
 * `PAYMENT_PROCESSING`, `LISTING_UNAVAILABLE`) or a Stripe error.
 */
export async function startCheckout(
  orderId: string,
  { origin, client: injected, db }: { origin: string; client?: StripeCheckoutClient; db?: Db },
): Promise<{ url: string; sessionId: string; reused: boolean }> {
  const stripe = injected ?? getStripe();
  const conn = db ?? (await getDb());
  const order = await getOrder(orderId, conn);
  if (!order) throw new OrderError("ORDER_NOT_FOUND", `Order ${orderId} not found`);
  if (order.paymentStatus === "paid") {
    throw new OrderError("ORDER_NOT_PENDING", `Order ${order.id} is already paid`);
  }
  const previousId = order.stripeCheckoutSessionId;

  let stored: StoredSession | null = null;
  if (previousId) {
    try {
      stored = await stripe.checkout.sessions.retrieve(previousId);
    } catch (err) {
      if (!isResourceMissing(err)) throw err;
      console.warn(`[stripe] stored session for order ${order.id} no longer exists; creating a new one`);
    }
  }
  // `complete` on a pending order = paid (or async payment processing), webhook not yet applied.
  // On a `failed` order it is the session whose async payment failed, so a retry replaces it.
  if (stored?.status === "complete" && order.paymentStatus === "pending") throw paymentProcessing(order.id);

  const [context] = await conn
    .select({ title: listings.title, listingStatus: listings.status, offerStatus: offers.status })
    .from(offers)
    .innerJoin(listings, eq(offers.listingId, listings.id))
    .where(eq(offers.id, order.offerId))
    .limit(1);
  if (!context || context.offerStatus !== "accepted" || context.listingStatus !== "available") {
    throw new OrderError(
      "LISTING_UNAVAILABLE",
      `Order ${order.id} cannot be paid: listing is ${context?.listingStatus ?? "missing"}, offer is ${context?.offerStatus ?? "missing"}`,
    );
  }

  if (stored?.status === "open" && stored.url) {
    return { url: stored.url, sessionId: stored.id, reused: true };
  }
  if (stored && stored.status !== "expired" && stored.status !== "complete") {
    // Unknown state (or open without a URL): close it so it can never be paid alongside the new one.
    try {
      await stripe.checkout.sessions.expire(stored.id);
    } catch (err) {
      const now = await stripe.checkout.sessions.retrieve(stored.id);
      if (now.status === "complete") throw paymentProcessing(order.id);
      if (now.status !== "expired") throw err;
    }
  }

  const session = await createCheckoutSessionForOrder(order, {
    origin,
    productName: `${context.title} — PingMarket order ${order.id} (offer ${order.offerId})`,
    client: stripe,
  });
  if (await attachCheckoutSession(order.id, session.id, previousId, conn)) {
    return { url: session.url, sessionId: session.id, reused: false };
  }

  // Lost the race (another click or the webhook changed the order): drop ours, return theirs.
  await stripe.checkout.sessions.expire(session.id).catch(() => undefined);
  const current = await getOrder(order.id, conn);
  if (!current) throw new OrderError("ORDER_NOT_FOUND", `Order ${order.id} not found`);
  if (current.paymentStatus === "paid") {
    throw new OrderError("ORDER_NOT_PENDING", `Order ${order.id} is already paid`);
  }
  if (current.stripeCheckoutSessionId) {
    const winner = await stripe.checkout.sessions.retrieve(current.stripeCheckoutSessionId);
    if (winner.status === "open" && winner.url) return { url: winner.url, sessionId: winner.id, reused: true };
    if (winner.status === "complete") throw paymentProcessing(order.id);
  }
  throw new Error(`Concurrent checkout for order ${order.id} left no open session; retry`);
}

export type StripeWebhookErrorCode = "WEBHOOK_NOT_CONFIGURED" | "INVALID_SIGNATURE";

export class StripeWebhookError extends Error {
  constructor(
    public readonly code: StripeWebhookErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StripeWebhookError";
  }
}

/**
 * Verifies the `stripe-signature` header against `STRIPE_WEBHOOK_SECRET` over the raw body and returns the event.
 * Throws `StripeWebhookError`. Needs no API key.
 */
export function verifyStripeWebhook(rawBody: string, signature: string | null): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new StripeWebhookError("WEBHOOK_NOT_CONFIGURED", "Stripe webhook not configured (set STRIPE_WEBHOOK_SECRET)");
  }
  if (!signature) throw new StripeWebhookError("INVALID_SIGNATURE", "Missing stripe-signature header");
  try {
    return Stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    throw new StripeWebhookError("INVALID_SIGNATURE", "Invalid Stripe webhook signature");
  }
}
