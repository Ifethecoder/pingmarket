import { describe, expect, it } from "vitest";
import { createListingRequestSchema, createOfferRequestSchema, positiveCentsSchema } from "./contracts";

describe("createOfferRequestSchema", () => {
  it("accepts listingId + priceCents only", () => {
    expect(createOfferRequestSchema.parse({ listingId: "D1", priceCents: 5000 })).toEqual({
      listingId: "D1",
      priceCents: 5000,
    });
  });

  it.each([{ buyerId: "x" }, { source: "sms" }, { buyerId: "u_seller_demo", source: "sms" }])(
    "rejects caller-chosen identity %o",
    (extra) => {
      const result = createOfferRequestSchema.safeParse({ listingId: "D1", priceCents: 5000, ...extra });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.code).toBe("unrecognized_keys");
    },
  );
});

describe("positiveCentsSchema", () => {
  it("bounds cents to a Postgres integer", () => {
    expect(positiveCentsSchema.safeParse(2_147_483_647).success).toBe(true);
    expect(positiveCentsSchema.safeParse(2_147_483_648).success).toBe(false);
    expect(createOfferRequestSchema.safeParse({ listingId: "D1", priceCents: 3_000_000_000 }).success).toBe(false);
  });
});

describe("createListingRequestSchema currency", () => {
  const base = { sellerId: "u_seller_demo", marketplaceId: "furniture", title: "Desk", priceCents: 100 };

  it("upper-cases a 3-letter code", () => {
    expect(createListingRequestSchema.parse({ ...base, currency: "eur" }).currency).toBe("EUR");
  });

  it.each(["12$", "US", "EURO", "€€€"])("rejects %s", (currency) => {
    expect(createListingRequestSchema.safeParse({ ...base, currency }).success).toBe(false);
  });
});
