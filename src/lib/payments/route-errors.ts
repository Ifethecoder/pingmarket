/** Shared error -> HTTP mapping for the order payment routes (checkout, confirm). */
import type { NextResponse } from "next/server";
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
