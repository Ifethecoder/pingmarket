import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db";
import { messages, offers } from "../db/schema";
import { createTestDb } from "../db/testing";
import { createOffer } from "../offers/service";
import { getOrCreateOrderForOffer, markOrderPaid } from "../orders/service";
import { runSearch } from "../search/service";
import { formatMoney, listTraceEvents, maskPhone } from "./service";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  await db.insert(messages).values({
    id: "msg_1",
    dialEventId: "evt_1",
    fromNumber: "+15550000002",
    toNumber: "+15550000001",
    body: "SELL oak desk, $120, Berkeley. Pickup only.",
    direction: "inbound",
  });
  await createOffer({ listingId: "D1", priceCents: 10000 }, db);
  await runSearch({ query: "poster", includeExternalAgents: false }, { db });
});

describe("listTraceEvents", () => {
  it("formats helpers", () => {
    expect(maskPhone("+1 (555) 000-0002")).toBe("…0002");
    expect(formatMoney(120000)).toBe("$1,200.00");
    expect(formatMoney(1250, "12$")).toBe("$12.50"); // invalid currency falls back instead of throwing
  });

  it("unions messages, listings, searches and offers newest first", async () => {
    const events = await listTraceEvents(50, db);
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds).toEqual(new Set(["sms_inbound", "listing_created", "offer", "search"]));
    const ats = events.map((e) => e.at);
    expect(ats).toEqual([...ats].sort().reverse());

    const sms = events.find((e) => e.kind === "sms_inbound");
    expect(sms?.summary).toBe("…0002 → …0001: SELL oak desk, $120, Berkeley. Pickup only.");
    expect(sms?.summary).not.toContain("5550000002");
    expect(events.find((e) => e.id === "listing:D1")?.summary).toBe(
      "Listing D1 created: Oak desk — $120.00 (Furniture Market)",
    );
    expect(events.find((e) => e.kind === "offer")?.summary).toMatch(
      /^Offer O\d+: \$100\.00 for D1 — open \(web_simulated\)$/,
    );
    expect(events.find((e) => e.kind === "search")?.summary).toMatch(
      /^Search "poster" → Darwin skipped, \d+ native$/,
    );
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it("respects the limit", async () => {
    expect(await listTraceEvents(3, db)).toHaveLength(3);
  });
});

describe("listTraceEvents orders", () => {
  it("emits order_created and, once the webhook marks it paid, a payment event", async () => {
    const orderDb = await createTestDb();
    const offer = await createOffer({ listingId: "D2", priceCents: 11000 }, orderDb);
    await orderDb.update(offers).set({ status: "accepted" }).where(eq(offers.id, offer.id));
    const { order } = await getOrCreateOrderForOffer(offer.id, orderDb);

    let events = await listTraceEvents(50, orderDb);
    expect(events.find((e) => e.kind === "order_created")?.summary).toBe(
      `Order ${order.id} created for offer ${offer.id} · $110.00 pending`,
    );
    expect(events.some((e) => e.kind === "payment")).toBe(false);

    await markOrderPaid({ orderId: order.id, sessionId: "cs_test_trace" }, orderDb);
    events = await listTraceEvents(50, orderDb);
    const payment = events.find((e) => e.kind === "payment");
    expect(payment?.summary).toBe(`Order ${order.id} paid via Stripe test checkout · $110.00`);
    expect(payment?.detail).toMatchObject({ orderId: order.id, listingId: "D2", paymentStatus: "paid" });
    expect(events.findIndex((e) => e.kind === "payment")).toBeLessThan(
      events.findIndex((e) => e.kind === "order_created"),
    );
  });
});
