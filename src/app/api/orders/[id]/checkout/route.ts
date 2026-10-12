import { NextResponse } from "next/server";
import { appOrigin } from "@/lib/payments/origin";
import { afterResponse, paymentErrorResponse } from "@/lib/payments/route-errors";
import { startCheckout } from "@/lib/payments/stripe";

/**
 * POST /api/orders/{id}/checkout → `{ url, sessionId }` for a hosted Stripe test-mode Checkout page.
 * Reuses the order's session while it is still open. Never marks the order paid from the link itself;
 * a `complete` stored session is confirmed with Stripe first (409 `ORDER_NOT_PENDING` "Order already paid").
 * 503 `STRIPE_NOT_CONFIGURED` / `APP_URL_REQUIRED`; 409 `ORDER_NOT_PENDING` (paid), `PAYMENT_PROCESSING`
 * (paid on Stripe, webhook pending), `LISTING_UNAVAILABLE`; 400 `STRIPE_INVALID_REQUEST`; 502 `STRIPE_ERROR`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { url, sessionId } = await startCheckout(id, { origin: appOrigin(req), schedule: afterResponse });
    return NextResponse.json({ url, sessionId });
  } catch (err) {
    return paymentErrorResponse("POST /api/orders/[id]/checkout", err);
  }
}
