import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/sms/simulate/buy/route";
import type { Db } from "../db";
import * as dbModule from "../db";
import { listings, messages, offers, orders } from "../db/schema";
import { createTestDb } from "../db/testing";
import { createListing, getListing } from "../listings/service";
import { acceptOffer } from "../negotiation/db-service";
import { createOffer, getOffer, listOffers } from "../offers/service";
import { getSimHandset } from "../sms/sim-handsets";
import { appOrigin } from "./origin";
import { buySimListing } from "./purchase";
import { confirmOrderPayment, type CheckoutSessionSnapshot, type StripeCheckoutClient } from "./stripe";
import * as stripeModule from "./stripe";

let db: Db;
const origin = "http://localhost:3000";
beforeAll(async () => { db = await createTestDb(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function fakeStripe() {
  const sessions = new Map<string, CheckoutSessionSnapshot>();
  let next = 0;
  const create = vi.fn(async (params: Stripe.Checkout.SessionCreateParams) => {
    const id = `cs_test_buy_${++next}`;
    const session: CheckoutSessionSnapshot = {
      id, url: `https://checkout.stripe.com/c/pay/${id}`, status: "open", livemode: false,
      client_reference_id: params.client_reference_id ?? null,
      metadata: params.metadata as Record<string, string>, payment_status: "unpaid",
      amount_total: params.line_items![0].price_data!.unit_amount!, currency: "usd",
    };
    sessions.set(id, session);
    return { id, url: session.url };
  });
  const client: StripeCheckoutClient = { checkout: { sessions: {
    create,
    retrieve: async (id) => sessions.get(id)!,
    expire: async (id) => { sessions.get(id)!.status = "expired"; return { id, status: "expired" }; },
  } } };
  return { client, create, sessions };
}

async function freshListing(priceCents = 12500, sellerId = "u_seller_2", currency = "USD") {
  return createListing({ sellerId, marketplaceId: "furniture", title: "Buy test chair", priceCents, currency }, db);
}

describe("simulator direct purchase", () => {
  it("reserves at the asking price, creates one pending order, and sends no sale notification before payment", async () => {
    const listing = await freshListing();
    const fake = fakeStripe();
    const buyer = await getSimHandset("buyer", db);
    const seller = await getSimHandset("seller", db);
    const before = await db.select().from(messages).where(eq(messages.toNumber, seller.number));
    const result = await buySimListing(listing.id, { origin, client: fake.client, db });
    expect(result.order).toMatchObject({ amountCents: listing.priceCents, paymentStatus: "pending", stripeCheckoutSessionId: result.sessionId });
    expect(await getListing(listing.id, db)).toMatchObject({ status: "reserved" });
    expect(await getOffer(result.order.offerId, db)).toMatchObject({ buyerId: buyer.userId, source: "web_simulated", status: "accepted", proposedPriceCents: listing.priceCents });
    expect(fake.create.mock.calls[0][0]).toMatchObject({
      success_url: `${origin}/sim?checkout=success&order=${result.order.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/sim?checkout=cancel&order=${result.order.id}`,
    });
    expect(await db.select().from(messages).where(eq(messages.toNumber, seller.number))).toHaveLength(before.length);
  });

  it("reuses the accepted negotiated price and its existing order", async () => {
    const listing = await freshListing(15000);
    const offer = await createOffer({ listingId: listing.id, priceCents: 11000 }, db);
    await acceptOffer({ offerId: offer.id, actorId: listing.sellerId }, db);
    const fake = fakeStripe();
    const first = await buySimListing(listing.id, { origin, client: fake.client, db });
    const repeat = await buySimListing(listing.id, { origin, client: fake.client, db });
    expect(first.order).toMatchObject({ offerId: offer.id, amountCents: 11000 });
    expect(repeat).toEqual(first);
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(await listOffers({ listingId: listing.id }, db)).toHaveLength(1);
  });

  it("concurrent clicks converge on one offer, order, and open checkout session", async () => {
    const listing = await freshListing();
    const fake = fakeStripe();
    const results = await Promise.all(Array.from({ length: 3 }, () => buySimListing(listing.id, { origin, client: fake.client, db })));
    expect(new Set(results.map((r) => r.order.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.sessionId)).size).toBe(1);
    expect(await listOffers({ listingId: listing.id }, db)).toHaveLength(1);
    expect(await db.select().from(orders).where(eq(orders.offerId, results[0].order.offerId))).toHaveLength(1);
    expect([...fake.sessions.values()].filter((s) => s.status === "open")).toHaveLength(1);
  });

  it("declines competing offers without telling the seller the item is purchased", async () => {
    const listing = await freshListing();
    const open = await createOffer({ listingId: listing.id, priceCents: 9000 }, db);
    const countered = await createOffer({ listingId: listing.id, priceCents: 9500 }, db);
    await db.update(offers).set({ status: "countered" }).where(eq(offers.id, countered.id));
    await buySimListing(listing.id, { origin, client: fakeStripe().client, db });
    expect(await getOffer(open.id, db)).toMatchObject({ status: "declined" });
    expect(await getOffer(countered.id, db)).toMatchObject({ status: "declined" });
    const rows = await db.select().from(messages);
    expect(rows.filter((m) => m.body.includes(listing.id)).map((m) => m.body)).toEqual([
      `Offer ${open.id} on ${listing.id} was declined.`,
      `Offer ${countered.id} on ${listing.id} was declined.`,
    ]);
  });

  it("rejects missing/live Stripe configuration before reserving or creating an offer", async () => {
    const listing = await freshListing();
    for (const key of ["", "sk_live_rejected"]) {
      vi.stubEnv("STRIPE_SECRET_KEY", key);
      await expect(buySimListing(listing.id, { origin, db })).rejects.toMatchObject({ code: "STRIPE_NOT_CONFIGURED" });
    }
    expect(await getListing(listing.id, db)).toMatchObject({ status: "available" });
    expect(await listOffers({ listingId: listing.id }, db)).toEqual([]);
  });

  it("rejects unavailable items, another buyer's reservation, self purchase, non-USD, and missing items", async () => {
    const fake = fakeStripe();
    for (const status of ["sold", "removed", "reserved"] as const) {
      const listing = await freshListing();
      await db.update(listings).set({ status }).where(eq(listings.id, listing.id));
      await expect(buySimListing(listing.id, { origin, client: fake.client, db })).rejects.toMatchObject({ code: "LISTING_UNAVAILABLE" });
    }
    const theirs = await freshListing();
    const otherOffer = await createOffer({ listingId: theirs.id, priceCents: 5000, buyerId: "u_sms_buyer" }, db);
    await acceptOffer({ offerId: otherOffer.id, actorId: theirs.sellerId }, db);
    await expect(buySimListing(theirs.id, { origin, client: fake.client, db })).rejects.toMatchObject({ code: "LISTING_UNAVAILABLE" });
    const self = await freshListing(10000, "u_web_buyer");
    await expect(buySimListing(self.id, { origin, client: fake.client, db })).rejects.toMatchObject({ code: "SELF_PURCHASE" });
    const euro = await freshListing(10000, "u_seller_2", "EUR");
    await expect(buySimListing(euro.id, { origin, client: fake.client, db })).rejects.toMatchObject({ code: "UNSUPPORTED_CURRENCY" });
    await expect(buySimListing("missing_listing", { origin, client: fake.client, db })).rejects.toMatchObject({ code: "LISTING_NOT_FOUND" });
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("confirms Stripe payment, marks the listing sold, and notifies the seller exactly once", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", ""); // Keep seller payout offline; Checkout uses an injected test client.
    const listing = await freshListing();
    const fake = fakeStripe();
    const purchase = await buySimListing(listing.id, { origin, client: fake.client, db });
    const unpaid = await confirmOrderPayment(purchase.order.id, { stripe: fake.client, db });
    expect(unpaid.confirmed).toBe(false);
    const session = fake.sessions.get(purchase.sessionId)!;
    session.status = "complete";
    session.payment_status = "paid";
    const paid = await confirmOrderPayment(purchase.order.id, { stripe: fake.client, db });
    expect(paid).toMatchObject({ confirmed: true, order: { paymentStatus: "paid" } });
    await confirmOrderPayment(purchase.order.id, { stripe: fake.client, db });
    expect(await getListing(listing.id, db)).toMatchObject({ status: "sold" });
    const seller = await getSimHandset("seller", db);
    const notices = await db.select().from(messages).where(and(eq(messages.toNumber, seller.number), eq(messages.direction, "outbound")));
    expect(notices.filter((m) => m.body.includes(purchase.order.id) && m.body.startsWith("Sold!"))).toHaveLength(1);
    await expect(buySimListing(listing.id, { origin, client: fake.client, db })).rejects.toMatchObject({ code: "LISTING_UNAVAILABLE" });
  });
});

describe("simulator buy route guards", () => {
  it("ignores a caller-supplied buyer identity and purchases as the fixed simulator buyer", async () => {
    const listing = await freshListing();
    const fake = fakeStripe();
    vi.spyOn(dbModule, "getDb").mockResolvedValue(db);
    vi.spyOn(stripeModule, "getStripe").mockReturnValue(fake.client as ReturnType<typeof stripeModule.getStripe>);
    const response = await POST(new Request(`${origin}/api/sms/simulate/buy`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ listingId: listing.id, buyerId: "u_seller_2", priceCents: 1 }),
    }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(await getOffer(result.order.offerId, db)).toMatchObject({ buyerId: "u_web_buyer", proposedPriceCents: listing.priceCents });
  });

  it("rejects cross-origin requests and non-JSON forms before purchasing", async () => {
    const foreign = await POST(new Request(`${origin}/api/sms/simulate/buy`, {
      method: "POST", headers: { origin: "https://foreign.example", "content-type": "application/json" }, body: '{"listingId":"D1"}',
    }));
    expect(foreign.status).toBe(403);
    const form = await POST(new Request(`${origin}/api/sms/simulate/buy`, { method: "POST", body: "listingId=D1" }));
    expect(form.status).toBe(403);
  });

  it("validates JSON and listing IDs", async () => {
    for (const body of ["{", '{"listingId":" "}', '{"buyerId":"u_seller_2"}']) {
      const response = await POST(new Request(`${origin}/api/sms/simulate/buy`, {
        method: "POST", headers: { "content-type": "application/json" }, body,
      }));
      expect(response.status).toBe(400);
    }
  });

  it("uses the configured HTTP origin and requires it in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "");
    expect(() => appOrigin(new Request(`${origin}/api`))).toThrow(expect.objectContaining({ code: "APP_URL_REQUIRED" }));
    vi.stubEnv("APP_URL", "https://pingmarket.example/path");
    expect(appOrigin(new Request(`${origin}/api`))).toBe("https://pingmarket.example");
    vi.stubEnv("APP_URL", "javascript:alert(1)");
    expect(() => appOrigin(new Request(`${origin}/api`))).toThrow(expect.objectContaining({ code: "APP_URL_REQUIRED" }));
  });
});
