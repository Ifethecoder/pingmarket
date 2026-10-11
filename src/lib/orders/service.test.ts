import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../db";
import { listings, offers } from "../db/schema";
import { createTestDb } from "../db/testing";
import { getListing } from "../listings/service";
import { createOffer } from "../offers/service";
import {
  attachCheckoutSession,
  getOrCreateOrderForOffer,
  getOrder,
  listOrders,
  markOrderPaid,
  markOrderPaymentFailed,
  OrderError,
} from "./service";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});

async function expectOrderError(p: Promise<unknown>, code: OrderError["code"]) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OrderError);
  expect((err as OrderError).code).toBe(code);
}

async function acceptedOffer(listingId: string, priceCents: number) {
  const offer = await createOffer({ listingId, priceCents }, db);
  await db.update(offers).set({ status: "accepted" }).where(eq(offers.id, offer.id));
  return offer;
}

describe("orders service", () => {
  it("creates a pending order at the accepted price, idempotently", async () => {
    const offer = await acceptedOffer("D1", 11000);
    const first = await getOrCreateOrderForOffer(offer.id, db);
    expect(first.created).toBe(true);
    expect(first.order).toMatchObject({
      offerId: offer.id,
      amountCents: 11000,
      paymentStatus: "pending",
      stripeCheckoutSessionId: null,
    });
    expect(first.order.id).toMatch(/^ORD\d+$/);

    const again = await getOrCreateOrderForOffer(offer.id, db);
    expect(again).toEqual({ order: first.order, created: false });

    const concurrent = await Promise.all([
      getOrCreateOrderForOffer(offer.id, db),
      getOrCreateOrderForOffer(offer.id, db),
    ]);
    expect(concurrent.map((r) => r.order.id)).toEqual([first.order.id, first.order.id]);
    expect((await listOrders(db)).filter((o) => o.offerId === offer.id)).toHaveLength(1);
  });

  it("rejects offers that are missing or not accepted", async () => {
    const open = await createOffer({ listingId: "D2", priceCents: 5000 }, db);
    await expectOrderError(getOrCreateOrderForOffer(open.id, db), "OFFER_NOT_ACCEPTED");
    await expectOrderError(getOrCreateOrderForOffer("O999999", db), "OFFER_NOT_FOUND");
    expect((await listOrders(db)).some((o) => o.offerId === open.id)).toBe(false);
  });

  it("markOrderPaid is idempotent and marks the listing sold", async () => {
    const offer = await acceptedOffer("D3", 4200);
    const { order } = await getOrCreateOrderForOffer(offer.id, db);
    expect(await attachCheckoutSession(order.id, "cs_test_paid", null, db)).toBe(true);

    const paid = await markOrderPaid({ orderId: order.id, sessionId: "cs_test_paid" }, db);
    expect(paid.changed).toBe(true);
    expect(paid.order).toMatchObject({ paymentStatus: "paid", stripeCheckoutSessionId: "cs_test_paid" });
    expect((await getListing("D3", db))?.status).toBe("sold");

    const dup = await markOrderPaid({ orderId: order.id, sessionId: "cs_test_paid" }, db);
    expect(dup).toEqual({ order: paid.order, changed: false });

    // Once paid, the order can no longer take a new checkout session.
    expect(await attachCheckoutSession(order.id, "cs_test_other", "cs_test_paid", db)).toBe(false);
    expect((await getOrder(order.id, db))?.stripeCheckoutSessionId).toBe("cs_test_paid");
  });

  it("attachCheckoutSession is a compare-and-swap on the previous session id", async () => {
    const offer = await acceptedOffer("D7", 8000);
    const { order } = await getOrCreateOrderForOffer(offer.id, db);
    expect(await attachCheckoutSession(order.id, "cs_test_a", null, db)).toBe(true);
    // A second request that also read "no session" loses.
    expect(await attachCheckoutSession(order.id, "cs_test_b", null, db)).toBe(false);
    expect((await getOrder(order.id, db))?.stripeCheckoutSessionId).toBe("cs_test_a");
    expect(await attachCheckoutSession(order.id, "cs_test_c", "cs_test_a", db)).toBe(true);
    expect(await attachCheckoutSession("ORD999999", "cs_test_x", null, db)).toBe(false);
  });

  it("a signed paid event wins over a newer pending session; a second payment of a paid order is rejected", async () => {
    const offer = await acceptedOffer("D4", 3000);
    const { order } = await getOrCreateOrderForOffer(offer.id, db);
    await attachCheckoutSession(order.id, "cs_test_a", null, db);
    await attachCheckoutSession(order.id, "cs_test_b", "cs_test_a", db);

    // Buyer paid the older session A after B replaced it: still paid, and A is recorded.
    const paid = await markOrderPaid({ orderId: order.id, sessionId: "cs_test_a" }, db);
    expect(paid).toMatchObject({ changed: true, order: { paymentStatus: "paid", stripeCheckoutSessionId: "cs_test_a" } });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expectOrderError(markOrderPaid({ orderId: order.id, sessionId: "cs_test_b" }, db), "SESSION_MISMATCH");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining(`order ${order.id} already paid with session cs_test_a`));
    errSpy.mockRestore();
    expect((await getOrder(order.id, db))?.stripeCheckoutSessionId).toBe("cs_test_a");
    await expectOrderError(markOrderPaid({ orderId: "ORD999999", sessionId: "cs_test_a" }, db), "ORDER_NOT_FOUND");
  });

  it("markOrderPaid stores the session id when none was attached yet", async () => {
    const offer = await acceptedOffer("D5", 2500);
    const { order } = await getOrCreateOrderForOffer(offer.id, db);
    const paid = await markOrderPaid({ orderId: order.id, sessionId: "cs_test_late" }, db);
    expect(paid.order).toMatchObject({ paymentStatus: "paid", stripeCheckoutSessionId: "cs_test_late" });
  });

  it("failed orders can be retried (attach resets to pending) and a signed paid event fixes them", async () => {
    const offer = await acceptedOffer("D6", 1500);
    const { order } = await getOrCreateOrderForOffer(offer.id, db);
    await attachCheckoutSession(order.id, "cs_test_async", null, db);

    // A failure for a session that is not current is ignored.
    await expectOrderError(markOrderPaymentFailed({ orderId: order.id, sessionId: "cs_test_stale" }, db), "SESSION_MISMATCH");
    const failed = await markOrderPaymentFailed({ orderId: order.id, sessionId: "cs_test_async" }, db);
    expect(failed).toMatchObject({ changed: true, order: { paymentStatus: "failed" } });
    expect((await markOrderPaymentFailed({ orderId: order.id, sessionId: "cs_test_async" }, db)).changed).toBe(false);
    expect((await getListing("D6", db))?.status).toBe("available");

    expect(await attachCheckoutSession(order.id, "cs_test_retry", "cs_test_async", db)).toBe(true);
    expect(await getOrder(order.id, db)).toMatchObject({ paymentStatus: "pending", stripeCheckoutSessionId: "cs_test_retry" });

    await markOrderPaymentFailed({ orderId: order.id, sessionId: "cs_test_retry" }, db);
    const paid = await markOrderPaid({ orderId: order.id, sessionId: "cs_test_retry" }, db);
    expect(paid).toMatchObject({ changed: true, order: { paymentStatus: "paid" } });
  });

  it("markOrderPaid still pays the order but logs a conflict when the listing is already sold", async () => {
    const offer = await acceptedOffer("D8", 6000);
    const { order } = await getOrCreateOrderForOffer(offer.id, db);
    await db.update(listings).set({ status: "sold" }).where(eq(listings.id, "D8"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const paid = await markOrderPaid({ orderId: order.id, sessionId: "cs_test_conflict" }, db);
    expect(paid.order.paymentStatus).toBe("paid");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining(`order ${order.id} paid but listing D8 was already sold`));
    errSpy.mockRestore();
  });
});
