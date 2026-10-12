import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, parseJsonBody, validationError } from "@/lib/http";
import { rejectCrossSite } from "@/lib/offers/transitions";
import { appOrigin } from "@/lib/payments/origin";
import { buySimListing, PURCHASE_ERROR_STATUS, PurchaseError } from "@/lib/payments/purchase";
import { afterResponse, paymentErrorResponse } from "@/lib/payments/route-errors";

const buySchema = z.object({ listingId: z.string().trim().min(1).max(100) });

/** POST {listingId}: reserve at asking price and open Stripe test Checkout for the simulator buyer. */
export async function POST(req: Request) {
  const refused = rejectCrossSite(req);
  if (refused) return refused;
  const body = await parseJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = buySchema.safeParse(body.body);
  if (!parsed.success) return validationError(parsed.error);
  try {
    return NextResponse.json(await buySimListing(parsed.data.listingId, {
      origin: appOrigin(req), schedule: afterResponse,
    }));
  } catch (err) {
    if (err instanceof PurchaseError) return jsonError(PURCHASE_ERROR_STATUS[err.code], err.message, { code: err.code });
    return paymentErrorResponse("POST /api/sms/simulate/buy", err);
  }
}
