/**
 * Route-level tests for POST /api/stripe/webhook (real signed payloads), POST /api/orders,
 * POST /api/orders/{id}/checkout and POST /api/orders/{id}/confirm.
 */
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as checkoutPOST } from "@/app/api/orders/[id]/checkout/route";
import { POST as confirmPOST } from "@/app/api/orders/[id]/confirm/route";
import { POST as payoutPOST } from "@/app/api/orders/[id]/payout/route";
import { POST as ordersPOST } from "@/app/api/orders/route";
import { POST as sellersPOST } from "@/app/api/stripe/sellers/route";
import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";
import type { Db } from "../db";
import { offers, users } from "../db/schema";
import { createTestDb } from "../db/testing";
import { createListing, getListing } from "../listings/service";
import { createOffer } from "../offers/service";
import { attachCheckoutSession, getOrder, listOrders, markOrderPaid } from "../orders/service";
import type { Order } from "../types";
import { getPayoutStripe, getStripe } from "./stripe";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: async () => state.db,
}));

// `after()` needs a Next request scope; here deferred tasks are queued and run by `flushAfter()`.
const deferred = vi.hoisted(() => ({ tasks: [] as Array<() => Promise<void>> }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<void>) => {
    deferred.tasks.push(task);
  },
}));
async function flushAfter() {
  while (deferred.tasks.length) await deferred.tasks.shift()!();
}

const SECRET = "whsec_route_test_secret";

/**
 * Stubs the memoized real Stripe clients (`getStripe()` for confirm, `getPayoutStripe()` for payouts) so
 * payment confirmation + seller payout run without network: a US platform, one connected account per seller,
 * transfers succeed, and every Checkout session is paid with a succeeded charge settling `amount` USD
 * (net = gross; fees are covered in payouts.test.ts). Undo with `vi.restoreAllMocks()`.
 */
function stubStripeForPayouts(amount: number, orderId: string) {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_route_payouts");
  const session = async (id: string) => ({
    id,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    livemode: false,
    client_reference_id: orderId,
    metadata: { orderId },
    amount_total: amount,
    currency: "usd",
    payment_intent: {
      id: `pi_${id}`,
      latest_charge: {
        id: `ch_${id}`,
        status: "succeeded",
        refunded: false,
        amount_refunded: 0,
        disputed: false,
        balance_transaction: { amount, net: amount, currency: "usd" },
      },
    },
  });
  const stripe = getStripe();
  const retrieve = vi
    .spyOn(stripe.checkout.sessions, "retrieve")
    .mockImplementation(session as unknown as typeof stripe.checkout.sessions.retrieve);
  const payout = getPayoutStripe();
  vi.spyOn(payout.checkout.sessions, "retrieve").mockImplementation(
    session as unknown as typeof payout.checkout.sessions.retrieve,
  );
  const accountsCreate = vi.spyOn(payout.accounts, "create").mockImplementation((async (
    params: Stripe.AccountCreateParams,
  ) => ({ id: `acct_${(params.metadata as Record<string, string>).pingmarketUserId}` })) as unknown as typeof payout.accounts.create);
  vi.spyOn(payout.accounts, "list").mockImplementation((async () => ({
    data: [],
    has_more: false,
  })) as unknown as typeof payout.accounts.list);
  vi.spyOn(payout.accounts, "retrieve").mockImplementation((async (id: string | null) => ({
    id: id ?? "acct_platform",
    country: "US",
    default_currency: "usd",
    capabilities: { transfers: "active" },
  })) as unknown as typeof payout.accounts.retrieve);
  vi.spyOn(payout.transfers, "list").mockImplementation((async () => ({
    data: [],
    has_more: false,
  })) as unknown as typeof payout.transfers.list);
  const transfersCreate = vi.spyOn(payout.transfers, "create").mockImplementation((async () => ({
    id: `tr_route_${orderId}`,
  })) as unknown as typeof payout.transfers.create);
  return { retrieve, accountsCreate, transfersCreate };
}
let db: Db;
let eventSeq = 0;

beforeAll(async () => {
  db = await createTestDb();
  state.db = db;
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  deferred.tasks.length = 0;
});

function sessionEvent(
  type: string,
  session: Record<string, unknown>,
  { id = `evt_test_${++eventSeq}`, livemode = false }: { id?: string; livemode?: boolean } = {},
) {
  return JSON.stringify({
    id,
    object: "event",
    type,
    livemode,
    api_version: "2026-09-30.endive",
    created: Math.floor(Date.now() / 1000),
    data: { object: { object: "checkout.session", ...session } },
  });
}

function postWebhook(payload: string, signature: string | null = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET })) {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) headers.set("stripe-signature", signature);
  return webhookPOST(new Request("http://localhost:3000/api/stripe/webhook", { method: "POST", headers, body: payload }));
}

async function orderWithSession(listingId: string, priceCents: number, sessionId: string): Promise<Order> {
  const offer = await createOffer({ listingId, priceCents }, db);
  await db.update(offers).set({ status: "accepted" }).where(eq(offers.id, offer.id));
  const res = await ordersPOST(
    new Request("http://localhost:3000/api/orders", { method: "POST", body: JSON.stringify({ offerId: offer.id }) }),
  );
  expect(res.status).toBe(201);
  const { order } = (await res.json()) as { order: Order };
  await attachCheckoutSession(order.id, sessionId, null, db);
  return order;
}

describe("POST /api/stripe/webhook", () => {
  it("marks the order paid on a signed checkout.session.completed, idempotently", async () => {
    const order = await orderWithSession("D1", 11000, "cs_test_route_1");
    const payload = sessionEvent("checkout.session.completed", {
      id: "cs_test_route_1",
      client_reference_id: order.id,
      metadata: { orderId: order.id, offerId: order.offerId },
      payment_status: "paid",
      status: "complete",
      amount_total: 11000,
      currency: "usd",
    });

    const first = await postWebhook(payload);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true, orderId: order.id, paymentStatus: "paid", changed: true });
    expect((await getOrder(order.id, db))?.paymentStatus).toBe("paid");
    expect((await getListing("D1", db))?.status).toBe("sold");

    // Stripe redelivers the exact same event.
    const dup = await postWebhook(payload);
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ received: true, paymentStatus: "paid", changed: false });
    expect((await getOrder(order.id, db))?.paymentStatus).toBe("paid");

    expect((await listOrders(db)).find((o) => o.id === order.id)?.paymentStatus).toBe("paid");
  });

  it("rejects bad or missing signatures with 400 and changes nothing", async () => {
    const order = await orderWithSession("D2", 5000, "cs_test_route_2");
    const payload = sessionEvent("checkout.session.completed", {
      id: "cs_test_route_2",
      client_reference_id: order.id,
      payment_status: "paid",
    });
    const forged = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_attacker" });
    const bad = await postWebhook(payload, forged);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "INVALID_SIGNATURE" });
    expect((await postWebhook(payload, null)).status).toBe(400);
    expect((await postWebhook(payload, "t=1,v1=deadbeef")).status).toBe(400);
    expect((await getOrder(order.id, db))?.paymentStatus).toBe("pending");
  });

  it("returns 503 when STRIPE_WEBHOOK_SECRET is unset", async () => {
    const payload = sessionEvent("checkout.session.completed", { id: "cs_x", payment_status: "paid" });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    try {
      const res = await postWebhook(payload, header);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "WEBHOOK_NOT_CONFIGURED" });
    } finally {
      vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
    }
  });

  it("leaves the order pending for unpaid completions and expiry; fails it only on async_payment_failed", async () => {
    const order = await orderWithSession("D3", 3000, "cs_test_route_3");
    const ref = { id: "cs_test_route_3", client_reference_id: order.id };

    const unpaid = await postWebhook(sessionEvent("checkout.session.completed", { ...ref, payment_status: "unpaid" }));
    expect(await unpaid.json()).toMatchObject({ paymentStatus: "pending" });
    expect((await getOrder(order.id, db))?.paymentStatus).toBe("pending");

    const expired = await postWebhook(sessionEvent("checkout.session.expired", { ...ref, status: "expired" }));
    expect(expired.status).toBe(200);
    expect((await getOrder(order.id, db))?.paymentStatus).toBe("pending");

    const failed = await postWebhook(
      sessionEvent("checkout.session.async_payment_failed", { ...ref, payment_status: "unpaid" }),
    );
    expect(await failed.json()).toMatchObject({ paymentStatus: "failed", changed: true });
    expect((await getOrder(order.id, db))?.paymentStatus).toBe("failed");
  });

  it("pays via async_payment_succeeded using metadata.orderId", async () => {
    const order = await orderWithSession("D4", 2500, "cs_test_route_4");
    const res = await postWebhook(
      sessionEvent("checkout.session.async_payment_succeeded", {
        id: "cs_test_route_4",
        client_reference_id: null,
        metadata: { orderId: order.id },
        payment_status: "paid",
        amount_total: 2500,
        currency: "usd",
      }),
    );
    expect(await res.json()).toMatchObject({ paymentStatus: "paid", changed: true });
  });

  it("pays a pending order for an older session that was replaced, recording that session", async () => {
    const order = await orderWithSession("D5", 4000, "cs_test_old_a");
    await attachCheckoutSession(order.id, "cs_test_new_b", "cs_test_old_a", db);
    const paidA = sessionEvent("checkout.session.completed", {
      id: "cs_test_old_a",
      client_reference_id: order.id,
      payment_status: "paid",
      amount_total: 4000,
      currency: "usd",
    });
    const res = await postWebhook(paidA);
    expect(await res.json()).toMatchObject({ paymentStatus: "paid", changed: true });
    expect(await getOrder(order.id, db)).toMatchObject({ paymentStatus: "paid", stripeCheckoutSessionId: "cs_test_old_a" });

    // A second, different paid session for the already-paid order: acknowledged, logged, not applied.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const paidB = await postWebhook(
      sessionEvent("checkout.session.completed", {
        id: "cs_test_new_b",
        client_reference_id: order.id,
        payment_status: "paid",
        amount_total: 4000,
        currency: "usd",
      }),
    );
    expect(paidB.status).toBe(200);
    expect(await paidB.json()).toMatchObject({ ignored: true, reason: "SESSION_MISMATCH" });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("cs_test_new_b"));
    errSpy.mockRestore();
    warnSpy.mockRestore();
    expect((await getOrder(order.id, db))?.stripeCheckoutSessionId).toBe("cs_test_old_a");
  });

  it("does not mark paid when the paid amount or currency differs from the order", async () => {
    const order = await orderWithSession("D6", 6000, "cs_test_amount");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [amount_total, currency] of [
      [100, "usd"],
      [6000, "eur"],
    ] as const) {
      const res = await postWebhook(
        sessionEvent("checkout.session.completed", {
          id: "cs_test_amount",
          client_reference_id: order.id,
          payment_status: "paid",
          amount_total,
          currency,
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true, ignored: true, reason: "amount_mismatch" });
    }
    expect(errSpy).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
    expect((await getOrder(order.id, db))?.paymentStatus).toBe("pending");
  });

  it("ignores live-mode events", async () => {
    const order = await orderWithSession("D7", 9000, "cs_test_live");
    const res = await postWebhook(
      sessionEvent(
        "checkout.session.completed",
        { id: "cs_test_live", client_reference_id: order.id, payment_status: "paid", amount_total: 9000, currency: "usd" },
        { livemode: true },
      ),
    );
    expect(await res.json()).toEqual({ received: true, ignored: true, reason: "livemode" });
    expect((await getOrder(order.id, db))?.paymentStatus).toBe("pending");
  });

  it("handles two concurrent deliveries of the same paid event: exactly one change", async () => {
    const order = await orderWithSession("D8", 7000, "cs_test_concurrent");
    const payload = sessionEvent("checkout.session.completed", {
      id: "cs_test_concurrent",
      client_reference_id: order.id,
      payment_status: "paid",
      amount_total: 7000,
      currency: "usd",
    });
    const responses = await Promise.all([postWebhook(payload), postWebhook(payload)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as { changed: boolean }[];
    expect(bodies.filter((b) => b.changed)).toHaveLength(1);
    expect((await getOrder(order.id, db))?.paymentStatus).toBe("paid");
  });

  it("acknowledges but ignores unknown orders and unrelated event types", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unknown = await postWebhook(
      sessionEvent("checkout.session.completed", {
        id: "cs_test_x",
        client_reference_id: "ORD999999",
        payment_status: "paid",
        amount_total: 100,
        currency: "usd",
      }),
    );
    expect(await unknown.json()).toMatchObject({ ignored: true, reason: "ORDER_NOT_FOUND" });
    warnSpy.mockRestore();

    const other = await postWebhook(sessionEvent("customer.created", { id: "cus_123" }));
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ received: true, ignored: true });
  });
});

describe("POST /api/orders and /api/orders/{id}/checkout", () => {
  it("validates input and refuses offers that are not accepted", async () => {
    const bad = await ordersPOST(new Request("http://localhost/api/orders", { method: "POST", body: "{}" }));
    expect(bad.status).toBe(400);
    const open = await createOffer({ listingId: "D6", priceCents: 1000 }, db);
    const res = await ordersPOST(
      new Request("http://localhost/api/orders", { method: "POST", body: JSON.stringify({ offerId: open.id }) }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "OFFER_NOT_ACCEPTED" });
  });

  it("returns 200 for an existing order and 503 STRIPE_NOT_CONFIGURED from checkout without a key", async () => {
    const order = await orderWithSession("D7", 9000, "cs_test_route_7");
    const again = await ordersPOST(
      new Request("http://localhost/api/orders", { method: "POST", body: JSON.stringify({ offerId: order.offerId }) }),
    );
    expect(again.status).toBe(200);
    expect(((await again.json()) as { order: Order }).order.id).toBe(order.id);

    vi.stubEnv("STRIPE_SECRET_KEY", ""); // restored by vi.unstubAllEnvs() in afterAll
    const res = await checkoutPOST(new Request(`http://localhost/api/orders/${order.id}/checkout`, { method: "POST" }), {
      params: Promise.resolve({ id: order.id }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "STRIPE_NOT_CONFIGURED" });
    expect((await getOrder(order.id, db))?.paymentStatus).toBe("pending");
  });

  it("requires APP_URL in production (no Host-derived return URLs)", async () => {
    const order = await orderWithSession("D2", 5000, "cs_test_route_app_url");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "");
    const res = await checkoutPOST(new Request(`https://evil.example/api/orders/${order.id}/checkout`, { method: "POST" }), {
      params: Promise.resolve({ id: order.id }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "APP_URL_REQUIRED" });
    vi.stubEnv("NODE_ENV", "test");
  });
});

describe("POST /api/orders/{id}/confirm", () => {
  async function freshOrderWithSession(priceCents: number, sessionId: string | null) {
    const listing = await createListing(
      { sellerId: "u_seller_demo", marketplaceId: "creative", title: "Confirm test print", priceCents },
      db,
    );
    const offer = await createOffer({ listingId: listing.id, priceCents }, db);
    await db.update(offers).set({ status: "accepted" }).where(eq(offers.id, offer.id));
    const res = await ordersPOST(
      new Request("http://localhost/api/orders", { method: "POST", body: JSON.stringify({ offerId: offer.id }) }),
    );
    const { order } = (await res.json()) as { order: Order };
    if (sessionId) await attachCheckoutSession(order.id, sessionId, null, db);
    return order;
  }

  function confirm(orderId: string, body?: string) {
    return confirmPOST(
      new Request(`http://localhost/api/orders/${orderId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      { params: Promise.resolve({ id: orderId }) },
    );
  }

  it("confirms a paid session read from Stripe with the secret key (no webhook involved) and pays the seller", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", ""); // the webhook is optional
    const order = await freshOrderWithSession(4200, "cs_test_ConfirmRoute1");
    const { retrieve, transfersCreate } = stubStripeForPayouts(4200, order.id);
    try {
      const res = await confirm(order.id, JSON.stringify({ sessionId: "cs_test_ConfirmRoute1" }));
      expect(res.status).toBe(200);
      // The buyer-facing response does not wait for the seller transfer: it runs after the response.
      expect(await res.json()).toMatchObject({
        confirmed: true,
        sessionStatus: "complete",
        paymentStatus: "paid",
        order: { id: order.id, paymentStatus: "paid", payoutStatus: "not_started" },
      });
      expect(retrieve).toHaveBeenCalledWith("cs_test_ConfirmRoute1");
      expect(transfersCreate).not.toHaveBeenCalled();
      await flushAfter();
      expect(transfersCreate).toHaveBeenCalledTimes(1);
      expect(await getOrder(order.id, db)).toMatchObject({ payoutStatus: "paid", payoutAmountCents: 4200 });

      // Empty body is allowed; a fully settled order is answered without asking Stripe again.
      retrieve.mockClear();
      const again = await confirm(order.id);
      expect(await again.json()).toMatchObject({ confirmed: true, order: { paymentStatus: "paid", payoutStatus: "paid" } });
      expect(retrieve).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
    }
  });

  it("validates the body and maps errors (404, 400, 503) and no_session", async () => {
    const missing = await confirm("ORD_NOPE");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "ORDER_NOT_FOUND" });

    const order = await freshOrderWithSession(1800, null);
    expect((await confirm(order.id, JSON.stringify({ sessionId: "https://evil.example" }))).status).toBe(400);
    expect((await confirm(order.id, "{not json")).status).toBe(400);
    const noSession = await confirm(order.id, "");
    expect(await noSession.json()).toMatchObject({ confirmed: false, reason: "no_session" });

    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const unconfigured = await confirm(order.id, JSON.stringify({ sessionId: "cs_test_whatever" }));
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({ code: "STRIPE_NOT_CONFIGURED" });
    expect((await getOrder(order.id, db))?.paymentStatus).toBe("pending");
  });
});

describe("seller payouts over HTTP", () => {
  async function paidOrderWithoutPayout(priceCents: number, sessionId: string) {
    const listing = await createListing(
      { sellerId: "u_seller_2", marketplaceId: "furniture", title: "Payout route chair", priceCents },
      db,
    );
    const offer = await createOffer({ listingId: listing.id, priceCents }, db);
    await db.update(offers).set({ status: "accepted" }).where(eq(offers.id, offer.id));
    const res = await ordersPOST(
      new Request("http://localhost/api/orders", { method: "POST", body: JSON.stringify({ offerId: offer.id }) }),
    );
    const { order } = (await res.json()) as { order: Order };
    await attachCheckoutSession(order.id, sessionId, null, db);
    return order;
  }

  function payout(orderId: string) {
    return payoutPOST(new Request(`http://localhost/api/orders/${orderId}/payout`, { method: "POST" }), {
      params: Promise.resolve({ id: orderId }),
    });
  }

  it("a signed paid webhook also pays the seller", async () => {
    const order = await paidOrderWithoutPayout(3300, "cs_test_webhook_payout");
    const { transfersCreate } = stubStripeForPayouts(3300, order.id);
    try {
      const res = await postWebhook(
        sessionEvent("checkout.session.completed", {
          id: "cs_test_webhook_payout",
          client_reference_id: order.id,
          payment_status: "paid",
          amount_total: 3300,
          currency: "usd",
        }),
      );
      expect(await res.json()).toMatchObject({ paymentStatus: "paid", changed: true });
      expect(transfersCreate).not.toHaveBeenCalled(); // deferred until after the 200
      await flushAfter();
      expect(transfersCreate).toHaveBeenCalledTimes(1);
      expect(transfersCreate.mock.calls[0][0]).toMatchObject({
        amount: 3300,
        currency: "usd",
        destination: "acct_u_seller_2",
        transfer_group: order.id,
        source_transaction: "ch_cs_test_webhook_payout",
      });
      expect(await getOrder(order.id, db)).toMatchObject({ payoutStatus: "paid", stripeTransferId: `tr_route_${order.id}` });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("POST /api/orders/{id}/payout: 409 before payment, retries a failed payout, then is a no-op", async () => {
    const order = await paidOrderWithoutPayout(2700, "cs_test_payout_route");
    const notPaid = await payout(order.id);
    expect(notPaid.status).toBe(409);
    expect(await notPaid.json()).toMatchObject({ code: "ORDER_NOT_PAID" });
    expect((await payout("ORD_NOPE")).status).toBe(404);

    // Paid while Stripe had no test key: the payout was skipped, the payment stands.
    await markOrderPaid({ orderId: order.id, sessionId: "cs_test_payout_route" }, db);
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const noKey = await payout(order.id);
    expect(noKey.status).toBe(503);

    const { transfersCreate } = stubStripeForPayouts(2700, order.id);
    try {
      transfersCreate.mockRejectedValueOnce(
        new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", message: "Insufficient funds", code: "balance_insufficient" }),
      );
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const failed = await payout(order.id);
      expect(failed.status).toBe(200);
      expect(await failed.json()).toMatchObject({ outcome: "failed", order: { paymentStatus: "paid", payoutStatus: "failed" } });

      const retried = await payout(order.id);
      expect(await retried.json()).toMatchObject({ outcome: "paid", order: { payoutStatus: "paid", payoutAmountCents: 2700 } });
      const done = await payout(order.id);
      expect(await done.json()).toMatchObject({ outcome: "already_paid" });
      expect(transfersCreate).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("POST /api/stripe/sellers provisions accounts, and reports Connect being off", async () => {
    const { accountsCreate } = stubStripeForPayouts(100, "ORD_unused");
    try {
      const res = await sellersPOST();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { connectEnabled: boolean; sellers: { userId: string; accountId: string; transfers: string }[] };
      expect(body.connectEnabled).toBe(true);
      expect(body.sellers.length).toBeGreaterThan(0);
      for (const seller of body.sellers) expect(seller).toMatchObject({ accountId: `acct_${seller.userId}`, transfers: "active" });

      // Every seller already has an account now; with Connect off, a NEW seller reports the reason.
      await db.insert(users).values({ id: "u_seller_new_route", role: "seller" });
      await createListing({ sellerId: "u_seller_new_route", marketplaceId: "creative", title: "New seller print", priceCents: 900 }, db);
      accountsCreate.mockRejectedValueOnce(
        new Stripe.errors.StripeInvalidRequestError({ message: "You can only create new accounts if you've signed up for Connect" }),
      );
      const off = (await (await sellersPOST()).json()) as { connectEnabled: boolean; sellers: { userId: string; error?: string }[] };
      expect(off.connectEnabled).toBe(false);
      expect(off.sellers.find((s) => s.userId === "u_seller_new_route")?.error).toBe("Stripe Connect not enabled");
    } finally {
      vi.restoreAllMocks();
    }
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_nope");
    expect((await sellersPOST()).status).toBe(503);
  });
});

describe("payout failures and gates over HTTP", () => {
  it("a non-Stripe payout error leaves the payment paid, the webhook 200, and the payout failed", async () => {
    const listing = await createListing(
      { sellerId: "u_seller_2", marketplaceId: "furniture", title: "Payout error stool", priceCents: 1900 },
      db,
    );
    const offer = await createOffer({ listingId: listing.id, priceCents: 1900 }, db);
    await db.update(offers).set({ status: "accepted" }).where(eq(offers.id, offer.id));
    const res = await ordersPOST(
      new Request("http://localhost/api/orders", { method: "POST", body: JSON.stringify({ offerId: offer.id }) }),
    );
    const { order } = (await res.json()) as { order: Order };
    await attachCheckoutSession(order.id, "cs_test_payout_boom", null, db);
    stubStripeForPayouts(1900, order.id);
    vi.spyOn(getPayoutStripe().transfers, "list").mockRejectedValue(new TypeError("unexpected shape"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const hook = await postWebhook(
        sessionEvent("checkout.session.completed", {
          id: "cs_test_payout_boom",
          client_reference_id: order.id,
          payment_status: "paid",
          amount_total: 1900,
          currency: "usd",
        }),
      );
      expect(hook.status).toBe(200);
      expect(await hook.json()).toMatchObject({ paymentStatus: "paid", changed: true });
      await flushAfter();
      expect(await getOrder(order.id, db)).toMatchObject({
        paymentStatus: "paid",
        payoutStatus: "failed",
        payoutError: "TypeError: unexpected shape",
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("test payout routes answer 403 in production unless ALLOW_TEST_PAYOUT_ROUTES=true", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const sellers = await sellersPOST();
      expect(sellers.status).toBe(403);
      expect(await sellers.json()).toMatchObject({ code: "TEST_ROUTES_DISABLED" });
      const payout = await payoutPOST(new Request("http://localhost/api/orders/ORD1/payout", { method: "POST" }), {
        params: Promise.resolve({ id: "ORD1" }),
      });
      expect(payout.status).toBe(403);
      vi.stubEnv("ALLOW_TEST_PAYOUT_ROUTES", "true");
      vi.stubEnv("STRIPE_SECRET_KEY", "");
      expect((await sellersPOST()).status).toBe(503); // allowed through the gate, then needs a test key
    } finally {
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("ALLOW_TEST_PAYOUT_ROUTES", "");
    }
  });
});

