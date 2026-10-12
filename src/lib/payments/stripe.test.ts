import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../db";
import { listings, offers } from "../db/schema";
import { createTestDb } from "../db/testing";
import { createListing, getListing } from "../listings/service";
import { createOffer } from "../offers/service";
import {
  attachCheckoutSession,
  getOrCreateOrderForOffer,
  getOrder,
  markOrderPaid,
  markOrderPaymentFailed,
  OrderError,
} from "../orders/service";
import {
  confirmOrderPayment,
  isStripeConfigured,
  startCheckout,
  StripeWebhookError,
  verifyStripeWebhook,
  type CheckoutSessionSnapshot,
  type StripeCheckoutClient,
} from "./stripe";

let db: Db;
const ORIGIN = "http://localhost:3000";

beforeAll(async () => {
  db = await createTestDb();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

type SessionStatus = "open" | "expired" | "complete";
type SessionDetails = Omit<CheckoutSessionSnapshot, "id" | "url" | "status">;

/**
 * In-memory Checkout Sessions: `create` mints `${prefix}_{n}` (open, unpaid, fields copied from the
 * create params); tests flip statuses via `sessions` and payment fields via `details` / `pay()`.
 */
function fakeStripe(prefix = "cs_test_fake") {
  let n = 0;
  const sessions = new Map<string, SessionStatus>();
  const details = new Map<string, Partial<SessionDetails>>();
  const url = (id: string) => `https://checkout.stripe.com/c/pay/${id}`;
  const create = vi.fn(async (params: Stripe.Checkout.SessionCreateParams) => {
    const id = `${prefix}_${++n}`;
    sessions.set(id, "open");
    const price = params.line_items?.[0]?.price_data;
    details.set(id, {
      client_reference_id: params.client_reference_id ?? null,
      metadata: (params.metadata as Record<string, string> | undefined) ?? {},
      amount_total: price?.unit_amount ?? null,
      currency: price?.currency ?? null,
    });
    return { id, url: url(id) };
  });
  const retrieve = vi.fn(async (id: string): Promise<CheckoutSessionSnapshot> => {
    const status = sessions.get(id);
    if (!status) {
      throw new Stripe.errors.StripeInvalidRequestError({ message: `No such checkout.session: '${id}'`, code: "resource_missing" });
    }
    return {
      id,
      url: status === "open" ? url(id) : null,
      status,
      livemode: false,
      client_reference_id: null,
      metadata: {},
      payment_status: "unpaid",
      amount_total: null,
      currency: "usd",
      ...details.get(id),
    };
  });
  const expire = vi.fn(async (id: string) => {
    sessions.set(id, "expired");
    return { id, status: "expired" as const };
  });
  /** Simulates the buyer paying on the hosted page. */
  const pay = (id: string) => {
    sessions.set(id, "complete");
    details.set(id, { ...details.get(id), payment_status: "paid" });
  };
  const client: StripeCheckoutClient = { checkout: { sessions: { create, retrieve, expire } } };
  return { client, create, retrieve, expire, sessions, details, pay };
}

/** Pending order on a brand-new listing (keeps tests independent of the seeded D1–D8). */
async function freshOrder(priceCents: number) {
  const listing = await createListing(
    { sellerId: "u_seller_demo", marketplaceId: "furniture", title: "Test lamp", priceCents },
    db,
  );
  return pendingOrder(listing.id, priceCents);
}

async function pendingOrder(listingId: string, priceCents: number) {
  const offer = await createOffer({ listingId, priceCents }, db);
  await db.update(offers).set({ status: "accepted" }).where(eq(offers.id, offer.id));
  return (await getOrCreateOrderForOffer(offer.id, db)).order;
}

describe("startCheckout", () => {
  it("creates a hosted test Checkout session for the order and stores its id (still pending)", async () => {
    const order = await pendingOrder("D1", 11000);
    const fake = fakeStripe();

    const result = await startCheckout(order.id, { origin: ORIGIN, client: fake.client, db });
    expect(result).toEqual({
      url: "https://checkout.stripe.com/c/pay/cs_test_fake_1",
      sessionId: "cs_test_fake_1",
      reused: false,
    });
    expect(fake.create).toHaveBeenCalledTimes(1);
    const params = fake.create.mock.calls[0][0];
    expect(params).toMatchObject({
      mode: "payment",
      client_reference_id: order.id,
      metadata: { orderId: order.id, offerId: order.offerId },
      // Separate charges and transfers: the seller transfer joins this group.
      payment_intent_data: { transfer_group: order.id, metadata: { orderId: order.id, offerId: order.offerId } },
      success_url: `${ORIGIN}/dashboard?checkout=success&order=${order.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${ORIGIN}/dashboard?checkout=cancel&order=${order.id}`,
    });
    // The braces must reach Stripe unencoded so it substitutes the real session id on redirect.
    expect(params.success_url).toContain("&session_id={CHECKOUT_SESSION_ID}");
    expect(params.line_items).toEqual([
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: 11000,
          product_data: { name: `Oak desk — PingMarket order ${order.id} (offer ${order.offerId})` },
        },
      },
    ]);
    expect(await getOrder(order.id, db)).toMatchObject({
      paymentStatus: "pending",
      stripeCheckoutSessionId: "cs_test_fake_1",
    });
  });

  it("reuses an open session and replaces an expired one", async () => {
    const order = await pendingOrder("D2", 5000);
    const fake = fakeStripe("cs_test_first");
    await startCheckout(order.id, { origin: ORIGIN, client: fake.client, db });
    const reused = await startCheckout(order.id, { origin: ORIGIN, client: fake.client, db });
    expect(reused).toMatchObject({ sessionId: "cs_test_first_1", reused: true });
    expect(fake.retrieve).toHaveBeenCalledWith("cs_test_first_1");
    expect(fake.create).toHaveBeenCalledTimes(1);

    fake.sessions.set("cs_test_first_1", "expired");
    const second = fakeStripe("cs_test_second");
    second.sessions.set("cs_test_first_1", "expired");
    const fresh = await startCheckout(order.id, { origin: ORIGIN, client: second.client, db });
    expect(fresh).toMatchObject({ sessionId: "cs_test_second_1", reused: false });
    expect(second.expire).not.toHaveBeenCalled();
    expect(await getOrder(order.id, db)).toMatchObject({
      paymentStatus: "pending",
      stripeCheckoutSessionId: "cs_test_second_1",
    });
  });

  it("never replaces a completed (paid, webhook pending) session: 409 PAYMENT_PROCESSING", async () => {
    const order = await pendingOrder("D4", 4000);
    const fake = fakeStripe("cs_test_done");
    await startCheckout(order.id, { origin: ORIGIN, client: fake.client, db });
    fake.sessions.set("cs_test_done_1", "complete");

    const err = await startCheckout(order.id, { origin: ORIGIN, client: fake.client, db }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderError);
    expect((err as OrderError).code).toBe("PAYMENT_PROCESSING");
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(await getOrder(order.id, db)).toMatchObject({ paymentStatus: "pending", stripeCheckoutSessionId: "cs_test_done_1" });
  });

  it("replaces a session Stripe no longer has, but rethrows other retrieve errors", async () => {
    const order = await pendingOrder("D5", 2000);
    await attachCheckoutSession(order.id, "cs_test_gone", null, db);
    const fake = fakeStripe("cs_test_new");
    const result = await startCheckout(order.id, { origin: ORIGIN, client: fake.client, db });
    expect(result).toMatchObject({ sessionId: "cs_test_new_1", reused: false });

    const broken = fakeStripe("cs_test_never");
    broken.retrieve.mockRejectedValueOnce(new Stripe.errors.StripeAPIError({ message: "upstream down" }));
    const err = await startCheckout(order.id, { origin: ORIGIN, client: broken.client, db }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Stripe.errors.StripeAPIError);
    expect(broken.create).not.toHaveBeenCalled();
    expect((await getOrder(order.id, db))?.stripeCheckoutSessionId).toBe("cs_test_new_1");
  });

  it("losing the attach race expires its own session and returns the winner's", async () => {
    const order = await pendingOrder("D6", 3500);
    const fake = fakeStripe("cs_test_race");
    // Another click attaches its session while ours is being created.
    fake.create.mockImplementationOnce(async () => {
      fake.sessions.set("cs_test_winner", "open");
      await attachCheckoutSession(order.id, "cs_test_winner", null, db);
      fake.sessions.set("cs_test_loser", "open");
      return { id: "cs_test_loser", url: "https://checkout.stripe.com/c/pay/cs_test_loser" };
    });
    const result = await startCheckout(order.id, { origin: ORIGIN, client: fake.client, db });
    expect(result).toEqual({
      url: "https://checkout.stripe.com/c/pay/cs_test_winner",
      sessionId: "cs_test_winner",
      reused: true,
    });
    expect(fake.expire).toHaveBeenCalledWith("cs_test_loser");
    expect((await getOrder(order.id, db))?.stripeCheckoutSessionId).toBe("cs_test_winner");
  });

  it("expires a stored session in any other state before replacing it", async () => {
    const order = await pendingOrder("D1", 1200);
    const fake = fakeStripe("cs_test_odd");
    await attachCheckoutSession(order.id, "cs_test_odd_state", null, db);
    fake.sessions.set("cs_test_odd_state", "processing" as SessionStatus);
    const result = await startCheckout(order.id, { origin: ORIGIN, client: fake.client, db });
    expect(fake.expire).toHaveBeenCalledWith("cs_test_odd_state");
    expect(result).toMatchObject({ sessionId: "cs_test_odd_1", reused: false });

    // If expiring fails and the session is still not expired/complete, the error propagates.
    const stuck = fakeStripe("cs_test_stuck");
    stuck.sessions.set("cs_test_odd_1", "processing" as SessionStatus);
    stuck.expire.mockRejectedValueOnce(new Stripe.errors.StripeAPIError({ message: "cannot expire" }));
    const err = await startCheckout(order.id, { origin: ORIGIN, client: stuck.client, db }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Stripe.errors.StripeAPIError);
    expect(stuck.create).not.toHaveBeenCalled();
  });

  it("lets a failed order retry with a new session (back to pending)", async () => {
    const order = await pendingOrder("D7", 2500);
    const fake = fakeStripe("cs_test_async");
    await startCheckout(order.id, { origin: ORIGIN, client: fake.client, db });
    fake.sessions.set("cs_test_async_1", "complete"); // async payment completed checkout, then failed
    await markOrderPaymentFailed({ orderId: order.id, sessionId: "cs_test_async_1" }, db);

    const retry = await startCheckout(order.id, { origin: ORIGIN, client: fake.client, db });
    expect(retry).toMatchObject({ sessionId: "cs_test_async_2", reused: false });
    expect(await getOrder(order.id, db)).toMatchObject({ paymentStatus: "pending", stripeCheckoutSessionId: "cs_test_async_2" });
  });

  it("refuses paid or unknown orders and orders whose listing is no longer available", async () => {
    const order = await pendingOrder("D3", 3000);
    await markOrderPaid({ orderId: order.id, sessionId: "cs_test_done" }, db);
    const fake = fakeStripe();
    const err = await startCheckout(order.id, { origin: ORIGIN, client: fake.client, db }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderError);
    expect((err as OrderError).code).toBe("ORDER_NOT_PENDING");
    const missing = await startCheckout("ORD999999", { origin: ORIGIN, client: fake.client, db }).catch((e: unknown) => e);
    expect((missing as OrderError).code).toBe("ORDER_NOT_FOUND");

    const other = await pendingOrder("D8", 1000);
    await db.update(listings).set({ status: "removed" }).where(eq(listings.id, "D8"));
    const unavailable = await startCheckout(other.id, { origin: ORIGIN, client: fake.client, db }).catch((e: unknown) => e);
    expect((unavailable as OrderError).code).toBe("LISTING_UNAVAILABLE");
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("reports STRIPE_NOT_CONFIGURED without a test-mode key", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(isStripeConfigured()).toBe(false);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_not_allowed");
    expect(isStripeConfigured()).toBe(false);
    const err = await startCheckout("ORD1", { origin: ORIGIN, db }).catch((e: unknown) => e);
    expect((err as OrderError).code).toBe("STRIPE_NOT_CONFIGURED");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    expect(isStripeConfigured()).toBe(true);
  });
});

describe("startCheckout with a completed stored session", () => {
  it("confirms a paid session with Stripe on the spot and reports the order as already paid", async () => {
    const order = await freshOrder(4500);
    const fake = fakeStripe("cs_test_selfheal");
    await startCheckout(order.id, { origin: ORIGIN, client: fake.client, db });
    fake.pay("cs_test_selfheal_1");

    const err = await startCheckout(order.id, { origin: ORIGIN, client: fake.client, db }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderError);
    expect((err as OrderError).code).toBe("ORDER_NOT_PENDING");
    expect((err as OrderError).message).toBe("Order already paid");
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(await getOrder(order.id, db)).toMatchObject({ paymentStatus: "paid", stripeCheckoutSessionId: "cs_test_selfheal_1" });
  });
});

describe("confirmOrderPayment", () => {
  it("marks the order paid when Stripe says the session is paid, idempotently", async () => {
    const order = await freshOrder(11000);
    const fake = fakeStripe("cs_test_confirm");
    const { sessionId } = await startCheckout(order.id, { origin: ORIGIN, client: fake.client, db });
    fake.pay(sessionId);

    const first = await confirmOrderPayment(order.id, { sessionId, stripe: fake.client, db });
    expect(first).toMatchObject({
      confirmed: true,
      sessionStatus: "complete",
      paymentStatus: "paid",
      order: { paymentStatus: "paid", stripeCheckoutSessionId: sessionId },
    });
    const listingId = (await db.select({ listingId: offers.listingId }).from(offers).where(eq(offers.id, order.offerId)))[0].listingId;
    expect((await getListing(listingId, db))?.status).toBe("sold");

    // Already paid: answered from the DB without calling Stripe.
    fake.retrieve.mockClear();
    const again = await confirmOrderPayment(order.id, { sessionId, stripe: fake.client, db });
    expect(again).toMatchObject({ confirmed: true, order: { paymentStatus: "paid" } });
    expect(fake.retrieve).not.toHaveBeenCalled();
  });

  it("uses the stored session when none is given and leaves an unpaid session pending", async () => {
    const order = await freshOrder(3000);
    const fake = fakeStripe("cs_test_unpaid");
    await startCheckout(order.id, { origin: ORIGIN, client: fake.client, db });

    const result = await confirmOrderPayment(order.id, { stripe: fake.client, db });
    expect(result).toMatchObject({
      confirmed: false,
      sessionStatus: "open",
      paymentStatus: "unpaid",
      order: { paymentStatus: "pending" },
    });
    expect(fake.retrieve).toHaveBeenCalledWith("cs_test_unpaid_1");
    expect(result.reason).toBeUndefined();
  });

  it("returns no_session when the order has no Checkout session yet", async () => {
    const order = await freshOrder(2000);
    const fake = fakeStripe();
    expect(await confirmOrderPayment(order.id, { stripe: fake.client, db })).toMatchObject({
      confirmed: false,
      reason: "no_session",
      order: { paymentStatus: "pending" },
    });
    expect(fake.retrieve).not.toHaveBeenCalled();
  });

  it("rejects a caller-supplied session that belongs to another order and changes nothing", async () => {
    const mine = await freshOrder(5000);
    const other = await freshOrder(5000);
    const fake = fakeStripe("cs_test_xorder");
    await startCheckout(mine.id, { origin: ORIGIN, client: fake.client, db });
    const { sessionId: otherSession } = await startCheckout(other.id, { origin: ORIGIN, client: fake.client, db });
    fake.pay(otherSession);

    const err = await confirmOrderPayment(mine.id, { sessionId: otherSession, stripe: fake.client, db }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderError);
    expect((err as OrderError).code).toBe("SESSION_MISMATCH");
    expect(await getOrder(mine.id, db)).toMatchObject({ paymentStatus: "pending", stripeCheckoutSessionId: "cs_test_xorder_1" });
    expect((await getOrder(other.id, db))?.paymentStatus).toBe("pending");
  });

  it("does not mark paid on amount mismatch, wrong currency or live mode", async () => {
    const order = await freshOrder(6000);
    const fake = fakeStripe("cs_test_guard");
    const { sessionId } = await startCheckout(order.id, { origin: ORIGIN, client: fake.client, db });
    fake.pay(sessionId);
    const base = fake.details.get(sessionId)!;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    for (const [patch, reason] of [
      [{ amount_total: 100 }, "amount_mismatch"],
      [{ currency: "eur" }, "amount_mismatch"],
      [{ livemode: true }, "livemode"],
    ] as const) {
      fake.details.set(sessionId, { ...base, ...patch });
      const result = await confirmOrderPayment(order.id, { sessionId, stripe: fake.client, db });
      expect(result).toMatchObject({ confirmed: false, reason, order: { paymentStatus: "pending" } });
    }
    expect(errSpy).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
    expect((await getOrder(order.id, db))?.paymentStatus).toBe("pending");
  });

  it("maps a session Stripe does not know to SESSION_NOT_FOUND, an unknown order to ORDER_NOT_FOUND", async () => {
    const order = await freshOrder(2500);
    const fake = fakeStripe();
    const missing = await confirmOrderPayment(order.id, { sessionId: "cs_test_nope", stripe: fake.client, db }).catch(
      (e: unknown) => e,
    );
    expect((missing as OrderError).code).toBe("SESSION_NOT_FOUND");
    const unknown = await confirmOrderPayment("ORD999999", { stripe: fake.client, db }).catch((e: unknown) => e);
    expect((unknown as OrderError).code).toBe("ORDER_NOT_FOUND");
  });

  it("reports STRIPE_NOT_CONFIGURED without a key (for a pending order with a session)", async () => {
    const order = await freshOrder(1500);
    await attachCheckoutSession(order.id, "cs_test_nokey", null, db);
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const err = await confirmOrderPayment(order.id, { db }).catch((e: unknown) => e);
    expect((err as OrderError).code).toBe("STRIPE_NOT_CONFIGURED");
  });
});

describe("verifyStripeWebhook", () => {
  const secret = "whsec_unit_test_secret";
  const payload = JSON.stringify({ id: "evt_unit", object: "event", type: "ping", data: { object: {} } });

  it("returns the event for a valid signature", () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", secret);
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    expect(verifyStripeWebhook(payload, header).id).toBe("evt_unit");
  });

  it("throws typed errors for a missing secret, a missing header or a bad signature", () => {
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    expect(() => verifyStripeWebhook(payload, header)).toThrow(
      expect.objectContaining({ code: "WEBHOOK_NOT_CONFIGURED" }),
    );
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", secret);
    expect(() => verifyStripeWebhook(payload, null)).toThrow(StripeWebhookError);
    expect(() => verifyStripeWebhook(`${payload} `, header)).toThrow(
      expect.objectContaining({ code: "INVALID_SIGNATURE" }),
    );
    const wrong = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_other" });
    expect(() => verifyStripeWebhook(payload, wrong)).toThrow(expect.objectContaining({ code: "INVALID_SIGNATURE" }));
  });
});
