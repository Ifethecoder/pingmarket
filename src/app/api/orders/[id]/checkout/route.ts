import { NextResponse } from "next/server";
import Stripe from "stripe";
import { internalError, jsonError } from "@/lib/http";
import { ORDER_ERROR_STATUS, OrderError } from "@/lib/orders/service";
import { startCheckout } from "@/lib/payments/stripe";

/**
 * Origin for Stripe return URLs. `APP_URL` (server-only, read at runtime) wins. Outside production the
 * request origin is accepted for local dev; in production `APP_URL` is required so a forged Host
 * header cannot turn the success/cancel URLs into an open redirect.
 */
function appOrigin(req: Request): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      throw new OrderError("APP_URL_REQUIRED", "APP_URL is not a valid absolute URL (e.g. https://pingmarket.example.com)");
    }
  }
  if (process.env.NODE_ENV !== "production") return new URL(req.url).origin;
  throw new OrderError("APP_URL_REQUIRED", "Set APP_URL to the app's public origin to enable checkout in production");
}

/**
 * POST /api/orders/{id}/checkout → `{ url, sessionId }` for a hosted Stripe test-mode Checkout page.
 * Reuses the order's session while it is still open. Never marks the order paid (only the webhook does).
 * 503 `STRIPE_NOT_CONFIGURED` / `APP_URL_REQUIRED`; 409 `ORDER_NOT_PENDING` (paid), `PAYMENT_PROCESSING`
 * (paid on Stripe, webhook pending), `LISTING_UNAVAILABLE`; 400 `STRIPE_INVALID_REQUEST`; 502 `STRIPE_ERROR`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { url, sessionId } = await startCheckout(id, { origin: appOrigin(req) });
    return NextResponse.json({ url, sessionId });
  } catch (err) {
    if (err instanceof OrderError) {
      return jsonError(ORDER_ERROR_STATUS[err.code], err.message, { code: err.code });
    }
    if (err instanceof Stripe.errors.StripeError) {
      // Never log the raw Stripe error object: it carries request details.
      console.error(`[api] POST /api/orders/[id]/checkout Stripe ${err.type} ${err.code ?? "-"}: ${err.message}`);
      if (err instanceof Stripe.errors.StripeInvalidRequestError) {
        return jsonError(400, err.message, { code: "STRIPE_INVALID_REQUEST" });
      }
      return jsonError(502, "Stripe request failed", { code: "STRIPE_ERROR" });
    }
    return internalError("POST /api/orders/[id]/checkout", err);
  }
}
