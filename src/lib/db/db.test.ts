import { count } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createListing,
  getListing,
  ListingError,
  listListings,
  updateListingStatus,
} from "../listings/service";
import { createOffer, getOffer, listOffers, OfferError } from "../offers/service";
import type { Db } from "./index";
import { marketplaces } from "./schema";
import { seed } from "./seed";
import { createTestDb } from "./testing";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});

async function expectListingError(p: Promise<unknown>, code: ListingError["code"]) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ListingError);
  expect((err as ListingError).code).toBe(code);
}

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

  it("createListing rejects non-positive, fractional or out-of-range prices", async () => {
    const base = { sellerId: "u_seller_demo", marketplaceId: "furniture" as const, title: "x" };
    await expectListingError(createListing({ ...base, priceCents: 0 }, db), "INVALID_PRICE");
    await expectListingError(createListing({ ...base, priceCents: 10.5 }, db), "INVALID_PRICE");
    await expectListingError(createListing({ ...base, priceCents: 2_147_483_648 }, db), "INVALID_PRICE");
  });

  it("createListing validates currency and normalizes it to upper case", async () => {
    const base = { sellerId: "u_seller_demo", marketplaceId: "furniture" as const, title: "x", priceCents: 100 };
    await expectListingError(createListing({ ...base, currency: "12$" }, db), "INVALID_CURRENCY");
    await expectListingError(createListing({ ...base, currency: "EURO" }, db), "INVALID_CURRENCY");
    expect((await createListing({ ...base, currency: "eur" }, db)).currency).toBe("EUR");
  });

  it("createListing rejects unknown sellers and marketplaces", async () => {
    await expectListingError(
      createListing({ sellerId: "u_nobody", marketplaceId: "furniture", title: "x", priceCents: 100 }, db),
      "SELLER_NOT_FOUND",
    );
    await expectListingError(
      createListing(
        // Direct (untyped) callers can pass an id that is not in the marketplaces table.
        { sellerId: "u_seller_demo", marketplaceId: "garden" as "furniture", title: "x", priceCents: 100 },
        db,
      ),
      "MARKETPLACE_NOT_FOUND",
    );
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
    await expectOfferError(createOffer({ listingId: "D2", priceCents: 3_000_000_000 }, db), "INVALID_PRICE");
  });

  it("createOffer still accepts an explicit SMS buyer for in-process callers", async () => {
    const offer = await createOffer({ listingId: "D2", priceCents: 9000, buyerId: "u_seller_demo", source: "sms" }, db);
    expect(offer).toMatchObject({ buyerId: "u_seller_demo", source: "sms", lastActorId: "u_seller_demo" });
  });

  it("createOffer runs in a transaction: a failed check leaves no offer behind", async () => {
    const before = (await listOffers({}, db)).length;
    const results = await Promise.allSettled([
      createOffer({ listingId: "D5", priceCents: 4000 }, db),
      createOffer({ listingId: "D5", priceCents: 4100 }, db),
      createOffer({ listingId: "D8", priceCents: 3000 }, db), // sold above
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    expect((await listOffers({}, db)).length).toBe(before + 2);
  });
});
