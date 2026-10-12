import { NextResponse } from "next/server";
import { internalError, jsonError } from "@/lib/http";
import { getNegotiationInsight } from "@/lib/keewano/insight";
import { getListing } from "@/lib/listings/service";
import { getOffer } from "@/lib/offers/service";

/**
 * GET /api/offers/{id}/insight → `{ insight: NegotiationInsight | null }`: live Keewano demand and counter
 * history for an offer awaiting the seller, with an ACCEPT / COUNTER recommendation. `insight` is null
 * with `code: "KEEWANO_NOT_CONFIGURED"` when the Keewano query env is unset.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const offer = await getOffer(id);
    if (!offer) return jsonError(404, `Offer ${id} not found`, { code: "OFFER_NOT_FOUND" });
    const listing = await getListing(offer.listingId);
    if (!listing) return jsonError(404, `Listing ${offer.listingId} not found`, { code: "LISTING_NOT_FOUND" });
    const insight = await getNegotiationInsight(offer, listing);
    return NextResponse.json(insight ? { insight } : { insight: null, code: "KEEWANO_NOT_CONFIGURED" });
  } catch (err) {
    return internalError("GET /api/offers/[id]/insight", err);
  }
}
