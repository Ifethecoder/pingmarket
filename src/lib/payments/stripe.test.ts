import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../db";
import { listings, offers } from "../db/schema";
import { createTestDb } from "../db/testing";
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
  isStripeConfigured,
  startCheckout,
  StripeWebhookError,
  verifyStripeWebhook,
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

/** In-memory Checkout Sessions: `create` mints `${prefix}_{n}` (open); tests flip statuses via `sessions`. */
function fakeStripe(prefix = "cs_test_fake") {
  let n = 0;
  const sessions = new Map<string, SessionStatus>();
  const url = (id: string) => `https://checkout.stripe.com/c/pay/${id}`;
  const create = vi.fn(async (params: Stripe.Checkout.SessionCreateParams) => {
    void params;
    const id = `${prefix}_${++n}`;
    sessions.set(id, "open");
    return { id, url: url(id) };
  });
  const retrieve = vi.fn(async (id: string) => {
    const status = sessions.get(id);
    if (!status) {
      throw new Stripe.errors.StripeInvalidRequestError({ message: `No such checkout.session: '${id}'`, code: "resource_missing" });
    }
    return { id, url: status === "open" ? url(id) : null, status };
  });
  const expire = vi.fn(async (id: string) => {
    sessions.set(id, "expired");
    return { id, status: "expired" as const };
  });
  const client: StripeCheckoutClient = { checkout: { sessions: { create, retrieve, expire } } };
  return { client, create, retrieve, expire, sessions };
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
      success_url: `${ORIGIN}/dashboard?checkout=success&order=${order.id}`,
      cancel_url: `${ORIGIN}/dashboard?checkout=cancel&order=${order.id}`,
    });
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
    await db.update(listings).set({ status: "reserved" }).where(eq(listings.id, "D8"));
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
