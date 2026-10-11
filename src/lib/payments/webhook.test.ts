/** Route-level tests for POST /api/stripe/webhook and POST /api/orders/{id}/checkout with real signed payloads. */
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as checkoutPOST } from "@/app/api/orders/[id]/checkout/route";
import { POST as ordersPOST } from "@/app/api/orders/route";
import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";
import type { Db } from "../db";
import { offers } from "../db/schema";
import { createTestDb } from "../db/testing";
import { getListing } from "../listings/service";
import { createOffer } from "../offers/service";
import { attachCheckoutSession, getOrder, listOrders } from "../orders/service";
import type { Order } from "../types";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: async () => state.db,
}));

const SECRET = "whsec_route_test_secret";
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
