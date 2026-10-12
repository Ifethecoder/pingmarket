/** Shared helpers for the payment routes: error -> HTTP mapping, deferred work, test-route gate. */
import { after, type NextResponse } from "next/server";
import Stripe from "stripe";
import { internalError, jsonError } from "../http";
import { ORDER_ERROR_STATUS, OrderError } from "../orders/service";

export function paymentErrorResponse(context: string, err: unknown): NextResponse {
  if (err instanceof OrderError) {
    return jsonError(ORDER_ERROR_STATUS[err.code], err.message, { code: err.code });
  }
  if (err instanceof Stripe.errors.StripeError) {
    // Never log the raw Stripe error object: it carries request details.
    console.error(`[api] ${context} Stripe ${err.type} ${err.code ?? "-"}: ${err.message}`);
    if (err instanceof Stripe.errors.StripeInvalidRequestError) {
      return jsonError(400, err.message, { code: "STRIPE_INVALID_REQUEST" });
    }
    return jsonError(502, "Stripe request failed", { code: "STRIPE_ERROR" });
  }
  return internalError(context, err);
}

/** Runs post-payment work (seller payout, payment texts) after the response is sent. */
export function afterResponse(task: () => Promise<void>): void {
  after(task);
}

/**
 * Operator test routes that move sandbox money (`/api/orders/{id}/payout`, `/api/stripe/sellers`) are off in
 * production unless `ALLOW_TEST_PAYOUT_ROUTES=true`. Returns the 403 response, or null when allowed.
 */
export function testPayoutRoutesForbidden(): NextResponse | null {
  if (process.env.NODE_ENV !== "production" || process.env.ALLOW_TEST_PAYOUT_ROUTES === "true") return null;
  return jsonError(403, "Test payout routes are disabled in production (set ALLOW_TEST_PAYOUT_ROUTES=true)", {
    code: "TEST_ROUTES_DISABLED",
  });
}
