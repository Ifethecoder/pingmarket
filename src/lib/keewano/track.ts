/**
 * Domain → Keewano events. Each helper is called after the database write commits and is
 * fire-and-forget (see `track()`): a no-op without KEEWANO_API_KEY, never throws.
 */
import type { Listing, Offer } from "../types";
import { listingKey, offerKey, pctBand, pctOfAsk, type KeewanoEvent } from "./catalog";
import { track } from "./ingest";

type ListingRef = Pick<Listing, "id" | "createdAt" | "marketplaceId" | "priceCents">;
type OfferRef = Pick<Offer, "id" | "createdAt">;

/** First events of every offer timeline: what is being negotiated, then the opening price. */
export function trackOfferCreated(offer: Offer, listing: ListingRef): void {
  const pct = pctOfAsk(offer.proposedPriceCents, listing.priceCents);
  track("offer", offerKey(offer), [
    { name: "Offer Key", value: offerKey(offer) },
    { name: "Offer Listing", value: listing.id },
    { name: "Offer Listing Key", value: listingKey(listing) },
    { name: "Offer Marketplace", value: listing.marketplaceId },
    { name: "Offer Source", value: offer.source },
    { name: "Offer Ask Cents", value: listing.priceCents },
    { name: "Offer Pct Of Ask", value: pct },
    { name: "Offer Band", value: pctBand(pct) },
    { name: "Offer Made Cents", value: offer.proposedPriceCents },
  ]);
}

/** A committed counter / accept / decline, plus the competing offers an accept superseded. */
export function trackOfferTransition(
  offer: Offer,
  listing: ListingRef,
  actorId: string,
  superseded: OfferRef[] = [],
): void {
  const role = actorId === offer.sellerId ? "seller" : "buyer";
  const events: KeewanoEvent[] = [];
  if (offer.status === "countered") {
    events.push(
      { name: "Counter Band", value: pctBand(pctOfAsk(offer.proposedPriceCents, listing.priceCents)) },
      { name: "Counter Cents", value: offer.proposedPriceCents },
    );
  } else if (offer.status === "accepted") {
    events.push({ name: "Offer Accepted", value: role });
  } else if (offer.status === "declined") {
    events.push({ name: "Offer Declined", value: role });
  }
  if (events.length > 0) track("offer", offerKey(offer), events);
  for (const other of superseded) track("offer", offerKey(other), [{ name: "Offer Superseded" }]);
}

export function trackOrderPaid(offer: OfferRef, amountCents: number): void {
  track("offer", offerKey(offer), [{ name: "Order Paid Cents", value: amountCents }]);
}

export function trackListingCreated(listing: ListingRef): void {
  track("listing", listingKey(listing), [
    { name: "Listing Key", value: listingKey(listing) },
    { name: "Listing Marketplace", value: listing.marketplaceId },
    { name: "Listing Ask Cents", value: listing.priceCents },
  ]);
}

/** Seeded listings never went through `trackListingCreated`, so each view restates the key first. */
export function trackListingViewed(listing: ListingRef, channel: "sms" | "sim"): void {
  track("listing", listingKey(listing), [
    { name: "Listing Key", value: listingKey(listing) },
    { name: "Listing Marketplace", value: listing.marketplaceId },
    { name: "Listing Viewed", value: channel },
  ]);
}

export function trackSearch(
  searchId: string,
  s: { marketplaceId: string | null; nativeCount: number; darwinStatus: string; externalCount: number },
): void {
  track("search", searchId, [
    { name: "Search Marketplace", value: s.marketplaceId ?? "all" },
    { name: "Search Darwin Status", value: s.darwinStatus },
    { name: "Search External Results", value: s.externalCount },
    { name: "Search Native Results", value: s.nativeCount },
  ]);
}
