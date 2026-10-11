import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../db";
import { listings, offers, orders } from "../db/schema";
import { createTestDb } from "../db/testing";
import { getListing } from "../listings/service";
import { createOffer, getOffer } from "../offers/service";
import { startCheckout, type StripeCheckoutClient } from "../payments/stripe";
import { acceptOffer, counterOffer, declineOffer, NegotiationError, type NegotiationErrorCode } from "./db-service";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});

async function expectCode(p: Promise<unknown>, code: NegotiationErrorCode) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(NegotiationError);
  expect((err as NegotiationError).code).toBe(code);
}

// D2/D4/D6/D8 belong to u_seller_2; D1/D3/D5/D7 to u_seller_demo. Offers come from u_web_buyer.
describe("negotiation over drizzle", () => {
  it("rejects unknown offers, outsiders, out-of-turn actors and bad prices", async () => {
    const offer = await createOffer({ listingId: "D1", priceCents: 10000 }, db);
    await expectCode(acceptOffer({ offerId: "O999999", actorId: "u_seller_demo" }, db), "OFFER_NOT_FOUND");
    await expectCode(acceptOffer({ offerId: offer.id, actorId: "u_seller_2" }, db), "FORBIDDEN");
    // An open offer waits on the seller: the buyer can't accept or decline their own offer.
    await expectCode(acceptOffer({ offerId: offer.id, actorId: "u_web_buyer" }, db), "FORBIDDEN");
    await expectCode(declineOffer({ offerId: offer.id, actorId: "u_web_buyer" }, db), "FORBIDDEN");
    await expectCode(counterOffer({ offerId: offer.id, actorId: "u_seller_demo", priceCents: 0 }, db), "INVALID_PRICE");
    expect((await getOffer(offer.id, db))?.status).toBe("open");
  });

  it("counter: seller only, on an open offer; then the buyer must answer", async () => {
    const offer = await createOffer({ listingId: "D3", priceCents: 18000 }, db);
    await expectCode(counterOffer({ offerId: offer.id, actorId: "u_web_buyer", priceCents: 19000 }, db), "FORBIDDEN");
    await db.update(offers).set({ expiresAt: new Date(Date.now() + 60_000) }).where(eq(offers.id, offer.id));
    const { offer: countered, changed } = await counterOffer({ offerId: offer.id, actorId: "u_seller_demo", priceCents: 20000 }, db);
    expect(changed).toBe(true);
    expect(countered).toMatchObject({ status: "countered", proposedPriceCents: 20000, lastActorId: "u_seller_demo" });
    expect(countered.updatedAt > offer.updatedAt).toBe(true);
    // A counter restarts the 24h clock for the buyer.
    expect(Date.parse(countered.expiresAt!) - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    // Countered: no second counter, and the seller can't accept their own counter.
    await expectCode(counterOffer({ offerId: offer.id, actorId: "u_seller_demo", priceCents: 19500 }, db), "FORBIDDEN");
    await expectCode(acceptOffer({ offerId: offer.id, actorId: "u_seller_demo" }, db), "FORBIDDEN");
    const declined = await declineOffer({ offerId: offer.id, actorId: "u_web_buyer" }, db);
    expect(declined).toMatchObject({ changed: true, offer: { status: "declined", lastActorId: "u_web_buyer" } });
    // Repeating DECLINE by the same party is a no-op; anything else on a closed offer is refused.
    const again = await declineOffer({ offerId: offer.id, actorId: "u_web_buyer" }, db);
    expect(again.changed).toBe(false);
    expect(again.offer.updatedAt).toBe(declined.offer.updatedAt);
    await expectCode(acceptOffer({ offerId: offer.id, actorId: "u_web_buyer" }, db), "OFFER_CLOSED");
    await expectCode(declineOffer({ offerId: offer.id, actorId: "u_seller_demo" }, db), "OFFER_CLOSED");
  });

  it("expired offers are not actionable", async () => {
    const offer = await createOffer({ listingId: "D5", priceCents: 4000 }, db);
    await db.update(offers).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(offers.id, offer.id));
    await expectCode(acceptOffer({ offerId: offer.id, actorId: "u_seller_demo" }, db), "OFFER_EXPIRED");
  });

  it("accept reserves the listing, declines competing offers, creates one order, and is idempotent", async () => {
    const winner = await createOffer({ listingId: "D2", priceCents: 8000 }, db);
    const loser = await createOffer({ listingId: "D2", priceCents: 7000 }, db);
    const countered = await createOffer({ listingId: "D2", priceCents: 6000 }, db);
    await counterOffer({ offerId: countered.id, actorId: "u_seller_2", priceCents: 9000 }, db);

    const { offer: accepted, changed, declined } = await acceptOffer({ offerId: winner.id, actorId: "u_seller_2" }, db);
    expect(changed).toBe(true);
    expect(accepted).toMatchObject({ status: "accepted", lastActorId: "u_seller_2", proposedPriceCents: 8000 });
    expect(declined.map((o) => o.id).sort()).toEqual([loser.id, countered.id].sort());
    expect(declined.every((o) => o.status === "declined" && o.lastActorId === "u_seller_2")).toBe(true);
    expect((await getListing("D2", db))?.status).toBe("reserved");
    expect((await getOffer(loser.id, db))?.status).toBe("declined");
    expect((await getOffer(countered.id, db))?.status).toBe("declined");
    const rows = await db.select().from(orders).where(eq(orders.offerId, winner.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountCents: 8000, paymentStatus: "pending" });

    const again = await acceptOffer({ offerId: winner.id, actorId: "u_seller_2" }, db);
    expect(again).toMatchObject({ changed: false, declined: [], offer: { status: "accepted" } });
    expect(await db.select().from(orders).where(eq(orders.offerId, winner.id))).toHaveLength(1);
    await expectCode(acceptOffer({ offerId: loser.id, actorId: "u_seller_2" }, db), "OFFER_CLOSED");

    // Checkout still works on the listing reserved for this accepted offer.
    const client: StripeCheckoutClient = {
      checkout: {
        sessions: {
          create: vi.fn(async () => ({ id: "cs_test_neg_1", url: "https://checkout.stripe.com/c/pay/cs_test_neg_1" })),
          retrieve: vi.fn(),
          expire: vi.fn(),
        },
      },
    };
    const checkout = await startCheckout(rows[0].id, { origin: "http://localhost:3000", client, db });
    expect(checkout.url).toContain("cs_test_neg_1");
  });

  it("accept requires an available listing", async () => {
    const offer = await createOffer({ listingId: "D4", priceCents: 7000 }, db);
    await db.update(listings).set({ status: "removed" }).where(eq(listings.id, "D4"));
    await expectCode(acceptOffer({ offerId: offer.id, actorId: "u_seller_2" }, db), "LISTING_UNAVAILABLE");
    expect((await getOffer(offer.id, db))?.status).toBe("open");
  });

  it("the web buyer accepts a seller counter", async () => {
    const offer = await createOffer({ listingId: "D6", priceCents: 5000 }, db);
    await counterOffer({ offerId: offer.id, actorId: "u_seller_2", priceCents: 5500 }, db);
    const { offer: accepted } = await acceptOffer({ offerId: offer.id, actorId: "u_web_buyer" }, db);
    expect(accepted).toMatchObject({ status: "accepted", proposedPriceCents: 5500, lastActorId: "u_web_buyer" });
    expect((await getListing("D6", db))?.status).toBe("reserved");
  });
});
