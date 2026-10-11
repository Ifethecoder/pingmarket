import { dashboardOfferTransition, rejectCrossSite } from "@/lib/offers/transitions";

/**
 * POST /api/offers/{id}/accept (JSON body `{}`, content-type application/json) → `{ offer }`. Seller accepts an `open` offer; a `countered`
 * offer is accepted for the web buyer, but an SMS buyer must text ACCEPT (409 SMS_BUYER_ONLY).
 * Accepting reserves the listing, declines competing offers and creates a pending order.
 * Errors: `{ error, code }` with 403 FORBIDDEN (also a non-JSON content-type or a foreign Origin), 404 OFFER_NOT_FOUND, 409 OFFER_CLOSED | OFFER_EXPIRED |
 * LISTING_UNAVAILABLE | SMS_BUYER_ONLY.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = rejectCrossSite(req);
  if (refused) return refused;
  const { id } = await params;
  return dashboardOfferTransition("accept", id);
}
