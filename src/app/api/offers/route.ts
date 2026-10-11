import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createOfferRequestSchema } from "@/lib/contracts";
import { internalError, jsonError, parseJsonBody, validationError } from "@/lib/http";
import { createOffer, listOffers, OfferError, type OfferErrorCode } from "@/lib/offers/service";
import type { OfferStatus } from "@/lib/types";

const OFFER_STATUSES = ["open", "countered", "accepted", "declined", "expired"] as const satisfies readonly OfferStatus[];

const listQuerySchema = z.object({
  listingId: z.string().trim().min(1).max(40).optional(),
  status: z.enum(OFFER_STATUSES).optional(),
});

const OFFER_ERROR_STATUS: Record<OfferErrorCode, number> = {
  LISTING_NOT_FOUND: 404,
  BUYER_NOT_FOUND: 404,
  LISTING_UNAVAILABLE: 409,
  INVALID_PRICE: 400,
  SELF_OFFER: 400,
};

/** GET /api/offers?listingId&status — newest first. */
export async function GET(req: NextRequest) {
  const parsed = listQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return validationError(parsed.error, "Invalid query parameters");
  try {
    return NextResponse.json({ offers: await listOffers(parsed.data) });
  } catch (err) {
    return internalError("GET /api/offers", err);
  }
}

/**
 * POST /api/offers — creates an `open` offer as the simulated web buyer (`u_web_buyer`, `web_simulated`). counter/accept/decline live under
 * /api/offers/{id}/… and are owned by Developer A.
 */
export async function POST(req: Request) {
  const parsedBody = await parseJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = createOfferRequestSchema.safeParse(parsedBody.body);
  if (!parsed.success) return validationError(parsed.error);
  try {
    // Always the simulated web buyer: HTTP callers can never pick buyerId/source.
    const { listingId, priceCents } = parsed.data;
    return NextResponse.json({ offer: await createOffer({ listingId, priceCents }) }, { status: 201 });
  } catch (err) {
    if (err instanceof OfferError) {
      return jsonError(OFFER_ERROR_STATUS[err.code], err.message, { code: err.code });
    }
    return internalError("POST /api/offers", err);
  }
}
