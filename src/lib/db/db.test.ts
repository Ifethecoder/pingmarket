import { count } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createListing, getListing, listListings, updateListingStatus } from "../listings/service";
import { createOffer, getOffer, listOffers, OfferError } from "../offers/service";
import type { Db } from "./index";
import { marketplaces } from "./schema";
import { seed } from "./seed";
import { createTestDb } from "./testing";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});

async function expectOfferError(p: Promise<unknown>, code: OfferError["code"]) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OfferError);
  expect((err as OfferError).code).toBe(code);
}

describe("db layer", () => {
  it("seed is idempotent", async () => {
    await seed(db);
    await seed(db);
    expect(await listListings({}, db)).toHaveLength(8);
    const [{ n }] = await db.select({ n: count() }).from(marketplaces);
    expect(n).toBe(2);
  });

  it("createListing mints an id that does not collide with seeded D1..D8", async () => {
    const listing = await createListing(
      { sellerId: "u_seller_demo", marketplaceId: "furniture", title: "Walnut side table", priceCents: 7000 },
      db,
    );
    expect(listing.id).toMatch(/^D\d+$/);
    expect(Number(listing.id.slice(1))).toBeGreaterThan(8);
    expect(listing).toMatchObject({ status: "available", visibility: "cross_market", currency: "USD" });
    expect(await getListing(listing.id, db)).toEqual(listing);
  });

  it("createListing rejects non-positive or fractional prices", async () => {
    const base = { sellerId: "u_seller_demo", marketplaceId: "furniture" as const, title: "x" };
    await expect(createListing({ ...base, priceCents: 0 }, db)).rejects.toThrow();
    await expect(createListing({ ...base, priceCents: 10.5 }, db)).rejects.toThrow();
  });

  it("createOffer on D1 opens an offer for the web buyer", async () => {
    const offer = await createOffer({ listingId: "D1", priceCents: 10000 }, db);
    expect(offer.id).toMatch(/^O\d+$/);
    expect(offer).toMatchObject({
      listingId: "D1",
      buyerId: "u_web_buyer",
      sellerId: "u_seller_demo",
      status: "open",
      lastActorId: "u_web_buyer",
      source: "web_simulated",
      proposedPriceCents: 10000,
    });
    expect(offer.expiresAt).not.toBeNull();
    expect(await getOffer(offer.id, db)).toEqual(offer);
    expect((await listOffers({ listingId: "D1" }, db)).map((o) => o.id)).toContain(offer.id);
  });

  it("createOffer on a sold listing throws LISTING_UNAVAILABLE", async () => {
    await updateListingStatus("D8", "sold", db);
    await expectOfferError(createOffer({ listingId: "D8", priceCents: 3000 }, db), "LISTING_UNAVAILABLE");
  });

  it("createOffer rejects self-offers, missing listings and unknown buyers", async () => {
    await expectOfferError(
      createOffer({ listingId: "D1", priceCents: 9000, buyerId: "u_seller_demo", source: "sms" }, db),
      "SELF_OFFER",
    );
    await expectOfferError(createOffer({ listingId: "D999", priceCents: 9000 }, db), "LISTING_NOT_FOUND");
    await expectOfferError(
      createOffer({ listingId: "D2", priceCents: 9000, buyerId: "u_nobody" }, db),
      "BUYER_NOT_FOUND",
    );
    await expectOfferError(createOffer({ listingId: "D2", priceCents: -1 }, db), "INVALID_PRICE");
  });
});
