import { NextResponse } from "next/server";
import { provisionSellerAccounts } from "@/lib/payments/payouts";
import { paymentErrorResponse, testPayoutRoutesForbidden } from "@/lib/payments/route-errors";

/**
 * POST /api/stripe/sellers (no body) → `{ connectEnabled, sellers: [{ userId, accountId, transfers, error? }] }`.
 * Gets or creates a Stripe Connect TEST connected account for every user who sells a listing, using the
 * dev server's database. Test-mode keys only (503 `STRIPE_NOT_CONFIGURED` otherwise). Same as
 * `npm run stripe:sellers`, but safe to call while `npm run dev` holds the embedded database.
 * 403 in production unless `ALLOW_TEST_PAYOUT_ROUTES=true`.
 */
export async function POST() {
  const forbidden = testPayoutRoutesForbidden();
  if (forbidden) return forbidden;
  try {
    return NextResponse.json(await provisionSellerAccounts());
  } catch (err) {
    return paymentErrorResponse("POST /api/stripe/sellers", err);
  }
}
