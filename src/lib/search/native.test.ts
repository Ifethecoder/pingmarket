import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db";
import { createTestDb } from "../db/testing";
import { createListing, updateListingStatus } from "../listings/service";
import { searchNative } from "./native";

const DEMO_QUERY = "desk under $150 in Berkeley; also interested in custom wall art";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});

const ids = (rs: { id: string }[]) => rs.map((r) => r.id);

describe("searchNative", () => {
  it("demo query from creative returns D1 (cross-market) and D6, not D3/D4/D8", async () => {
    const results = await searchNative({ query: DEMO_QUERY, marketplaceId: "creative" }, db);
    const byId = new Map(results.map((r) => [r.id, r]));

    expect(byId.get("D1")).toMatchObject({
      type: "native_listing",
      marketplaceId: "furniture",
      crossMarket: true,
    });
    expect(byId.get("D1")?.matchReasons).toEqual(
      expect.arrayContaining([
        'Title matches "desk"',
        "Under $150 budget",
        "Located in Berkeley",
        "Cross-market result from Furniture Market",
      ]),
    );
    expect(byId.get("D6")).toMatchObject({ marketplaceId: "creative", crossMarket: false });
    expect(ids(results)).not.toContain("D3"); // $220 > $150
    expect(ids(results)).not.toContain("D4"); // furniture marketplace_only
    expect(ids(results)).not.toContain("D8"); // Oakland != Berkeley
    for (const r of results) {
      expect(r).not.toHaveProperty("sellerId");
      expect(r.priceCents).toBeLessThanOrEqual(15000);
    }
  });

  it("is deterministic and ranks by score", async () => {
    const a = await searchNative({ query: DEMO_QUERY, marketplaceId: "creative" }, db);
    const b = await searchNative({ query: DEMO_QUERY, marketplaceId: "creative" }, db);
    expect(ids(a)).toEqual(ids(b));
    expect(ids(a).indexOf("D1")).toBeLessThan(ids(a).indexOf("D5")); // title hit beats description hit
  });

  it("marketplace_only listings are only visible from their own marketplace", async () => {
    const fromFurniture = await searchNative({ query: "poster", marketplaceId: "furniture" }, db);
    expect(ids(fromFurniture)).not.toContain("D8");
    const fromCreative = await searchNative({ query: "poster", marketplaceId: "creative" }, db);
    expect(ids(fromCreative)).toContain("D8");
    expect(fromCreative.find((r) => r.id === "D8")?.crossMarket).toBe(false);
  });

  it("without a marketplaceId only cross_market listings are visible", async () => {
    expect(ids(await searchNative({ query: "bookshelf" }, db))).not.toContain("D4");
    expect(ids(await searchNative({ query: "bookshelf", marketplaceId: "furniture" }, db))).toContain("D4");
  });

  it("marketplace hits match the category, not the generic marketplace name", async () => {
    const results = await searchNative({ query: "furniture", marketplaceId: "creative" }, db);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.marketplaceId === "furniture")).toBe(true);
    expect(results[0].matchReasons).toContain('Marketplace matches "furniture"');
    // "market" is a stopword and "Market" in the name never scores.
    const all = await searchNative({ query: "lamp market", marketplaceId: "creative" }, db);
    expect(ids(all)).toEqual(["D5"]);
  });

  it("explicit request filters override parsed ones", async () => {
    const results = await searchNative(
      { query: "desk", marketplaceId: "furniture", maxPriceCents: 30000, location: "Berkeley" },
      db,
    );
    expect(ids(results)).toEqual(expect.arrayContaining(["D1", "D3"]));
    expect(results.every((r) => !r.crossMarket)).toBe(true);
  });

  it("zero-token query returns all price/location filtered candidates", async () => {
    const results = await searchNative({ query: "$100 Berkeley" }, db);
    expect(ids(results).sort()).toEqual(["D5", "D6"]);
    for (const r of results) expect(r.crossMarket).toBe(false); // no marketplaceId -> never cross-market
  });

  it("excludes unavailable listings and passes null locations", async () => {
    const results = await searchNative({ query: "portrait in Berkeley" }, db);
    expect(ids(results)).toContain("D7"); // location null passes the location filter
    const created = await createListing(
      { sellerId: "u_seller_2", marketplaceId: "creative", title: "Portrait sketch", priceCents: 2000 },
      db,
    );
    await updateListingStatus(created.id, "sold", db);
    const after = await searchNative({ query: "portrait" }, db);
    expect(ids(after)).not.toContain(created.id);
  });
});
