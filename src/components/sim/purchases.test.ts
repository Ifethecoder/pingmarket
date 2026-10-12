import { describe, expect, it } from "vitest";
import type { Listing, Offer, Order } from "@/lib/types";
import { simulatorPurchases } from "./purchases";

const listing: Listing = {
  id: "D2", marketplaceId: "furniture", sellerId: "u_seller_2", title: "Desk",
  description: null, priceCents: 12000, currency: "USD", location: "Berkeley",
  status: "available", visibility: "marketplace_only", createdAt: "2026-10-11T00:00:00Z",
};
const offer: Offer = {
  id: "O1", listingId: "D2", buyerId: "u_web_buyer", sellerId: "u_seller_2",
  proposedPriceCents: 8000, status: "accepted", lastActorId: "u_seller_2",
  source: "web_simulated", expiresAt: null, createdAt: listing.createdAt, updatedAt: listing.createdAt,
};
const order: Order = {
  id: "order1", offerId: "O1", amountCents: 8000, paymentStatus: "pending",
  stripeCheckoutSessionId: "cs_test_1", paidAt: null, stripePaymentIntentId: null,
  payoutStatus: "not_started", stripeTransferId: null, payoutAmountCents: null,
  platformFeeCents: null, payoutCurrency: null, payoutError: null, payoutAt: null, createdAt: listing.createdAt,
};

describe("simulatorPurchases", () => {
  it("shows available items from the seller handset at their asking price", () => {
    expect(simulatorPurchases([listing], [], [], "furniture")).toEqual([{ listing, order: undefined, amountCents: 12000 }]);
  });

  it("restricts inventory to the seller handset and selected marketplace", () => {
    expect(simulatorPurchases([
      { ...listing, sellerId: "other_seller" },
      { ...listing, marketplaceId: "creative" },
      { ...listing, status: "removed" },
    ], [], [], "furniture")).toEqual([]);
  });

  it("shows an accepted buyer reservation at the agreed amount before an order exists", () => {
    const reserved = { ...listing, status: "reserved" as const };
    expect(simulatorPurchases([reserved], [offer], [], "furniture")).toEqual([{ listing: reserved, order: undefined, amountCents: 8000 }]);
  });

  it("uses the order amount for checkout and keeps the session available for resume", () => {
    const reserved = { ...listing, status: "reserved" as const };
    const agreed = { ...order, amountCents: 7500 };
    expect(simulatorPurchases([reserved], [offer], [agreed], "furniture")[0]).toEqual({ listing: reserved, order: agreed, amountCents: 7500 });
  });

  it("does not offer reserved items belonging to another buyer or unaccepted offers", () => {
    const reserved = { ...listing, status: "reserved" as const };
    expect(simulatorPurchases([reserved], [{ ...offer, buyerId: "other_buyer" }], [order], "furniture")).toEqual([]);
    expect(simulatorPurchases([reserved], [{ ...offer, status: "countered" }], [order], "furniture")).toEqual([]);
  });

  it("retains purchased items only when this buyer's order is paid", () => {
    const sold = { ...listing, status: "sold" as const };
    expect(simulatorPurchases([sold], [offer], [order], "furniture")).toEqual([]);
    const paid = { ...order, paymentStatus: "paid" as const };
    expect(simulatorPurchases([sold], [offer], [paid], "furniture")[0]).toEqual({ listing: sold, order: paid, amountCents: 8000 });
  });
});
