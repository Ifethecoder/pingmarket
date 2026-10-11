import { dashboardOfferTransition, rejectCrossSite } from "@/lib/offers/transitions";

/**
 * POST /api/offers/{id}/decline (JSON body `{}`, content-type application/json) → `{ offer }`. Seller declines an `open` offer; a `countered`
 * offer is declined for the web buyer, but an SMS buyer must text DECLINE (409 SMS_BUYER_ONLY).
 * Errors: `{ error, code }` with 403 FORBIDDEN (also a non-JSON content-type or a foreign Origin), 404 OFFER_NOT_FOUND, 409 OFFER_CLOSED | OFFER_EXPIRED |
 * SMS_BUYER_ONLY.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = rejectCrossSite(req);
  if (refused) return refused;
  const { id } = await params;
  return dashboardOfferTransition("decline", id);
}
