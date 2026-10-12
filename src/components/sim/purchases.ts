import type { Listing, MarketplaceId, Offer, Order } from "@/lib/types";

/** Only the seller handset's inventory and this buyer's accepted reservations are purchasable. */
export function simulatorPurchases(listings: Listing[], offers: Offer[], orders: Order[], marketplaceId: MarketplaceId) {
  return listings.flatMap((listing) => {
    if (listing.sellerId !== "u_seller_2" || listing.marketplaceId !== marketplaceId) return [];
    const offer = offers.find((offer) =>
      offer.listingId === listing.id && offer.buyerId === "u_web_buyer" && offer.status === "accepted",
    );
    const order = offer ? orders.find((order) => order.offerId === offer.id) : undefined;
    if (listing.status !== "available" && !(listing.status === "reserved" && offer) && !(listing.status === "sold" && order?.paymentStatus === "paid")) return [];
    return [{ listing, order, amountCents: order?.amountCents ?? offer?.proposedPriceCents ?? listing.priceCents }];
  });
}
