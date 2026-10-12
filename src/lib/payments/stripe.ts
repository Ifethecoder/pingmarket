/**
 * Stripe test-mode Checkout (PM-11). All Stripe-specific code lives here.
 * Hosted Checkout only: card details never touch PingMarket. After a confirmed payment the seller is paid
 * with a Stripe Connect test transfer (`payouts.ts`); no live payouts or settlement.
 * An order becomes `paid` only after the server reads the Checkout Session from Stripe with the secret key
 * (`confirmOrderPayment`: on return from Checkout or on demand) or receives it in an optional signed webhook.
 * Both paths go through `applyPaidCheckoutSession`. The redirect URL alone never marks anything paid.
 */
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { getDb, type Db } from "../db";
import { listings, offers } from "../db/schema";
import { attachCheckoutSession, getOrder, markOrderPaid, OrderError } from "../orders/service";
import type { Order } from "../types";
import { notifyOrderPaid } from "../sms/deliver";
import { isPayoutClient, payoutAfterPaid, type StripePayoutClient } from "./payouts";

/** The slice of the Stripe client used here; tests inject a fake. */
export interface StripeCheckoutClient {
  checkout: {
    sessions: {
      create(params: Stripe.Checkout.SessionCreateParams): Promise<Pick<Stripe.Checkout.Session, "id" | "url">>;
      retrieve(id: string): Promise<CheckoutSessionSnapshot>;
      expire(id: string): Promise<Pick<Stripe.Checkout.Session, "id" | "status">>;
    };
  };
}

/** The Checkout Session fields PingMarket reads. */
export type CheckoutSessionSnapshot = Pick<
  Stripe.Checkout.Session,
  | "id"
  | "url"
  | "status"
  | "livemode"
  | "client_reference_id"
  | "metadata"
  | "payment_status"
  | "amount_total"
  | "currency"
> & { success_url?: string | null };

let client: Stripe | null = null;
let payoutClient: Stripe | null = null;

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

/**
 * Memoized client for seller payouts with bounded latency (10s timeout, 1 network retry): payouts run after
 * the response, and an ambiguous timeout is safe because the transfer is replayed with the same idempotency
 * key and looked up by `transfer_group` first.
 */
export function getPayoutStripe(): Stripe {
  if (!isStripeConfigured()) {
    throw new OrderError("STRIPE_NOT_CONFIGURED", "Stripe not configured (set STRIPE_SECRET_KEY to a test-mode key)");
  }
  payoutClient ??= new Stripe(process.env.STRIPE_SECRET_KEY!.trim(), { timeout: 10_000, maxNetworkRetries: 1 });
  return payoutClient;
}

/**
 * Runs post-payment work (seller payout + payment texts). Routes pass `next/server`'s `after` so the
 * response does not wait on Stripe transfers; the default runs it inline (scripts, tests).
 */
export type Scheduler = (task: () => Promise<void>) => void | Promise<void>;
const inline: Scheduler = (task) => task();

/**
 * After an order is paid: pays the seller unless already done, then (first time only) texts both sides,
 * so the seller's "Sold!" text can include the payout result. Never throws.
 */
export async function settlePaidOrder(
  orderId: string,
  { changed, stripe, db }: { changed: boolean; stripe?: StripePayoutClient; db?: Db },
): Promise<void> {
  const conn = db ?? (await getDb());
  const order = await getOrder(orderId, conn);
  if (order && order.payoutStatus !== "paid") await payoutAfterPaid(orderId, { stripe, db: conn });
  if (changed) await notifyOrderPaid(orderId, conn);
}

export interface CheckoutOptions {
  /** Absolute app origin for the return URLs, e.g. `http://localhost:3000`. */
  origin: string;
  /** Trusted app page to return to after hosted Checkout. */
  returnPath?: "/dashboard" | "/sim";
  /** Line item name; defaults to `PingMarket order {id} (offer {offerId})`. */
  productName?: string;
  client?: StripeCheckoutClient;
}

/** Creates a hosted test-mode Checkout Session for one order. Does not touch the database. */
export async function createCheckoutSessionForOrder(
  order: Order,
  { origin, returnPath = "/dashboard", productName, client: injected }: CheckoutOptions,
): Promise<{ id: string; url: string }> {
  const stripe = injected ?? getStripe();
  const back = (result: "success" | "cancel") =>
    `${origin}${returnPath}?checkout=${result}&order=${encodeURIComponent(order.id)}`;
  // Plain concatenation: Stripe substitutes the literal `{CHECKOUT_SESSION_ID}` on redirect, and
  // URL/URLSearchParams would percent-encode the braces and break that.
  const successUrl = back("success") + "&session_id={CHECKOUT_SESSION_ID}";
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
    // Separate charges and transfers: the seller payout transfer joins this group (see payouts.ts).
    payment_intent_data: { transfer_group: order.id, metadata: { orderId: order.id, offerId: order.offerId } },
    metadata: { orderId: order.id, offerId: order.offerId },
    success_url: successUrl,
    cancel_url: back("cancel"),
  });
  if (!session.url) throw new Error(`Stripe returned no Checkout URL for session ${session.id}`);
  return { id: session.id, url: session.url };
}

export type ApplyPaidRejection =
  | "livemode"
  | "no_order_reference"
  | "order_mismatch"
  | "order_not_found"
  | "amount_mismatch"
  | "session_mismatch";

export type ApplyPaidResult =
  | { outcome: "paid"; order: Order; changed: boolean }
  | { outcome: "not_paid_yet"; order: Order }
  | { outcome: "rejected"; reason: ApplyPaidRejection; order: Order | null };

/** `client_reference_id`, falling back to `metadata.orderId`. */
export function orderIdOfSession(session: Pick<CheckoutSessionSnapshot, "client_reference_id" | "metadata">): string | null {
  return session.client_reference_id ?? session.metadata?.orderId ?? null;
}

/**
 * The single rule set for marking an order paid from a Checkout Session obtained from Stripe (retrieved
 * with the secret key, or delivered in a signed webhook). Requires ALL of: test mode (`livemode` false);
 * an order reference that resolves to an existing order (and equals `expectedOrderId` when given);
 * `payment_status` "paid"; `amount_total` equal to the order amount; currency "usd". Only then calls
 * `markOrderPaid` (idempotent). Expected failures are returned, not thrown.
 * Once the order is paid, `settlePaidOrder` (seller payout, then the payment texts the first time) runs via
 * `schedule`: inline by default, after the response when a route passes `after`. A payout problem is
 * recorded on the order and never changes this result.
 */
export async function applyPaidCheckoutSession(
  session: Omit<CheckoutSessionSnapshot, "url" | "status">,
  {
    expectedOrderId,
    db,
    payoutClient,
    schedule = inline,
  }: { expectedOrderId?: string; db?: Db; payoutClient?: StripePayoutClient; schedule?: Scheduler } = {},
): Promise<ApplyPaidResult> {
  if (session.livemode) return { outcome: "rejected", reason: "livemode", order: null };
  const orderId = orderIdOfSession(session);
  if (!orderId) return { outcome: "rejected", reason: "no_order_reference", order: null };
  const conn = db ?? (await getDb());
  if (expectedOrderId !== undefined && orderId !== expectedOrderId) {
    return { outcome: "rejected", reason: "order_mismatch", order: await getOrder(expectedOrderId, conn) };
  }
  const order = await getOrder(orderId, conn);
  if (!order) return { outcome: "rejected", reason: "order_not_found", order: null };
  if (session.payment_status !== "paid") return { outcome: "not_paid_yet", order };
  if (session.amount_total !== order.amountCents || session.currency !== "usd") {
    console.error(
      `[stripe] amount mismatch for order ${order.id} session ${session.id}: ` +
        `paid ${session.amount_total} ${session.currency}, expected ${order.amountCents} usd`,
    );
    return { outcome: "rejected", reason: "amount_mismatch", order };
  }
  try {
    const { order: paid, changed } = await markOrderPaid({ orderId: order.id, sessionId: session.id }, conn);
    if (paid.payoutStatus === "paid" && !changed) return { outcome: "paid", order: paid, changed };
    await schedule(() => settlePaidOrder(paid.id, { changed, stripe: payoutClient, db: conn }));
    return { outcome: "paid", order: (await getOrder(paid.id, conn)) ?? paid, changed };
  } catch (err) {
    // Already paid by a different session (logged loudly by markOrderPaid).
    if (err instanceof OrderError && err.code === "SESSION_MISMATCH") {
      return { outcome: "rejected", reason: "session_mismatch", order: await getOrder(order.id, conn) };
    }
    throw err;
  }
}

export interface ConfirmResult {
  order: Order;
  confirmed: boolean;
  /** Stripe Checkout Session `status` / `payment_status`; null when Stripe was not consulted. */
  sessionStatus: string | null;
  paymentStatus: string | null;
  /** Why a consulted session did not confirm payment (absent when confirmed or simply unpaid). */
  reason?: ApplyPaidRejection | "no_session";
}

/**
 * Pulls the truth from Stripe with the secret key, no webhook needed. Uses `sessionId` (e.g. from the
 * success redirect) or the order's stored session. A caller-supplied session belonging to another order
 * throws `SESSION_MISMATCH` and changes nothing. Throws `OrderError` (`ORDER_NOT_FOUND`,
 * `SESSION_NOT_FOUND`, `SESSION_MISMATCH`, `STRIPE_NOT_CONFIGURED`) or a Stripe error.
 */
export async function confirmOrderPayment(
  orderId: string,
  {
    sessionId,
    stripe: injected,
    db,
    schedule = inline,
  }: { sessionId?: string; stripe?: StripeCheckoutClient; db?: Db; schedule?: Scheduler } = {},
): Promise<ConfirmResult> {
  const conn = db ?? (await getDb());
  const order = await getOrder(orderId, conn);
  if (!order) throw new OrderError("ORDER_NOT_FOUND", `Order ${orderId} not found`);
  const payoutClient = isPayoutClient(injected) ? injected : undefined;
  if (order.paymentStatus === "paid") {
    // Already paid: Stripe is only consulted to (re)try a seller payout that has not succeeded yet,
    // e.g. after Connect was enabled.
    if (order.payoutStatus === "paid") return { order, confirmed: true, sessionStatus: null, paymentStatus: null };
    await schedule(() => payoutAfterPaid(order.id, { stripe: payoutClient, db: conn }));
    return { order: (await getOrder(order.id, conn)) ?? order, confirmed: true, sessionStatus: null, paymentStatus: null };
  }
  const id = sessionId ?? order.stripeCheckoutSessionId;
  if (!id) return { order, confirmed: false, sessionStatus: null, paymentStatus: null, reason: "no_session" };

  const stripe = injected ?? getStripe();
  let session: CheckoutSessionSnapshot;
  try {
    session = await stripe.checkout.sessions.retrieve(id);
  } catch (err) {
    if (isResourceMissing(err)) throw new OrderError("SESSION_NOT_FOUND", `Checkout session not found for order ${order.id}`);
    throw err;
  }
  const result = await applyPaidCheckoutSession(session, { expectedOrderId: order.id, db: conn, payoutClient, schedule });
  const status = { sessionStatus: session.status, paymentStatus: session.payment_status };
  switch (result.outcome) {
    case "paid":
      return { order: result.order, confirmed: true, ...status };
    case "not_paid_yet":
      return { order: result.order, confirmed: false, ...status };
    case "rejected":
      if (result.reason === "order_mismatch") {
        throw new OrderError("SESSION_MISMATCH", `Checkout session does not belong to order ${order.id}`);
      }
      return { order: result.order ?? order, confirmed: false, ...status, reason: result.reason };
  }
}

function isResourceMissing(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeInvalidRequestError && err.code === "resource_missing";
}

/**
 * A `complete` session on a pending order: confirm it with Stripe's data right away (self-heals without a
 * webhook). Returns `ORDER_NOT_PENDING` when that marked the order paid, else `PAYMENT_PROCESSING`
 * (e.g. a delayed payment method still settling).
 */
async function completedSessionError(
  session: CheckoutSessionSnapshot,
  orderId: string,
  db: Db,
  client: StripeCheckoutClient,
  schedule: Scheduler,
): Promise<OrderError> {
  const payoutClient = isPayoutClient(client) ? client : undefined;
  const result = await applyPaidCheckoutSession(session, { expectedOrderId: orderId, db, payoutClient, schedule });
  if (result.outcome === "paid") return new OrderError("ORDER_NOT_PENDING", "Order already paid");
  return new OrderError("PAYMENT_PROCESSING", `Payment for order ${orderId} is being processed by Stripe`);
}

/**
 * Returns a Checkout URL for a `pending` (or `failed`, to retry) order. The stored session is:
 * reused while `open` with the requested return page (otherwise expired before replacement);
 * never replaced once `complete` (confirmed with Stripe on the spot: `ORDER_NOT_PENDING`
 * if that marks it paid, else `PAYMENT_PROCESSING`);
 * replaced when `expired` or missing on Stripe; expired first in any other state. The new session id
 * is stored with a compare-and-swap, so concurrent clicks converge on one session.
 * Throws `OrderError` (`STRIPE_NOT_CONFIGURED`, `ORDER_NOT_FOUND`, `ORDER_NOT_PENDING`,
 * `PAYMENT_PROCESSING`, `LISTING_UNAVAILABLE`) or a Stripe error.
 */
export async function startCheckout(
  orderId: string,
  {
    origin,
    returnPath,
    client: injected,
    db,
    schedule = inline,
  }: { origin: string; returnPath?: "/dashboard" | "/sim"; client?: StripeCheckoutClient; db?: Db; schedule?: Scheduler },
): Promise<{ url: string; sessionId: string; reused: boolean }> {
  const stripe = injected ?? getStripe();
  const conn = db ?? (await getDb());
  const order = await getOrder(orderId, conn);
  if (!order) throw new OrderError("ORDER_NOT_FOUND", `Order ${orderId} not found`);
  if (order.paymentStatus === "paid") {
    throw new OrderError("ORDER_NOT_PENDING", `Order ${order.id} is already paid`);
  }
  const previousId = order.stripeCheckoutSessionId;

  let stored: CheckoutSessionSnapshot | null = null;
  if (previousId) {
    try {
      stored = await stripe.checkout.sessions.retrieve(previousId);
    } catch (err) {
      if (!isResourceMissing(err)) throw err;
      console.warn(`[stripe] stored session for order ${order.id} no longer exists; creating a new one`);
    }
  }
  // `complete` on a pending order = paid but not yet recorded (or async payment processing).
  // On a `failed` order it is the session whose async payment failed, so a retry replaces it.
  if (stored?.status === "complete" && order.paymentStatus === "pending") {
    throw await completedSessionError(stored, order.id, conn, stripe, schedule);
  }

  const [context] = await conn
    .select({ title: listings.title, listingStatus: listings.status, offerStatus: offers.status })
    .from(offers)
    .innerJoin(listings, eq(offers.listingId, listings.id))
    .where(eq(offers.id, order.offerId))
    .limit(1);
  // Accepting an offer reserves its listing (src/lib/negotiation/db-service.ts) and declines every
  // competing offer, so `reserved` here means reserved for this order's accepted offer.
  if (
    !context ||
    context.offerStatus !== "accepted" ||
    (context.listingStatus !== "available" && context.listingStatus !== "reserved")
  ) {
    throw new OrderError(
      "LISTING_UNAVAILABLE",
      `Order ${order.id} cannot be paid: listing is ${context?.listingStatus ?? "missing"}, offer is ${context?.offerStatus ?? "missing"}`,
    );
  }

  // A session's return URLs cannot be changed after creation. A simulator resume of a
  // dashboard checkout closes that unpaid session before creating one that returns to /sim.
  const returnMatches = !returnPath || !stored?.success_url || new URL(stored.success_url).pathname === returnPath;
  // A simulator BUY can re-price an unpaid order, so an open session for the old amount is replaced.
  const amountMatches = !stored || stored.amount_total == null || stored.amount_total === order.amountCents;
  if (stored?.status === "open" && stored.url && returnMatches && amountMatches) {
    return { url: stored.url, sessionId: stored.id, reused: true };
  }
  if (stored && stored.status !== "expired" && stored.status !== "complete") {
    // Unknown state (or open without a URL): close it so it can never be paid alongside the new one.
    try {
      await stripe.checkout.sessions.expire(stored.id);
    } catch (err) {
      const now = await stripe.checkout.sessions.retrieve(stored.id);
      if (now.status === "complete") throw await completedSessionError(now, order.id, conn, stripe, schedule);
      if (now.status !== "expired") throw err;
    }
  }

  const session = await createCheckoutSessionForOrder(order, {
    origin,
    returnPath,
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
    if (winner.status === "complete") throw await completedSessionError(winner, order.id, conn, stripe, schedule);
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
