import { NextResponse } from "next/server";
import { payoutSeller } from "@/lib/payments/payouts";
import { paymentErrorResponse, testPayoutRoutesForbidden } from "@/lib/payments/route-errors";

/**
 * POST /api/orders/{id}/payout → `{ order, outcome, transferId, error? }`: (re)tries the seller payout
 * (Stripe Connect test transfer) for a PAID order. `outcome` is `paid`, `already_paid` (no Stripe call),
 * `not_configured` (Connect not enabled) or `failed` (short Stripe error in `error`); those are 200s.
 * `in_progress` = another attempt holds the payout. 404 `ORDER_NOT_FOUND`, 409 `ORDER_NOT_PAID`,
 * 503 `STRIPE_NOT_CONFIGURED`, 403 in production unless `ALLOW_TEST_PAYOUT_ROUTES=true`.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const forbidden = testPayoutRoutesForbidden();
  if (forbidden) return forbidden;
  const { id } = await params;
  try {
    return NextResponse.json(await payoutSeller(id));
  } catch (err) {
    return paymentErrorResponse("POST /api/orders/[id]/payout", err);
  }
}
