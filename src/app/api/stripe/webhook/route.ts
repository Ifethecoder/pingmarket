import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { internalError, jsonError } from "@/lib/http";
import { markOrderPaymentFailed, OrderError } from "@/lib/orders/service";
import {
  applyPaidCheckoutSession,
  orderIdOfSession as orderIdOf,
  StripeWebhookError,
  verifyStripeWebhook,
  type ApplyPaidRejection,
} from "@/lib/payments/stripe";

/** Response `reason` for each rejection (kept stable for existing clients/tests). */
const REJECTION_REASON: Record<ApplyPaidRejection, string> = {
  livemode: "livemode",
  no_order_reference: "no order reference",
  order_mismatch: "order_mismatch",
  order_not_found: "ORDER_NOT_FOUND",
  amount_mismatch: "amount_mismatch",
  session_mismatch: "SESSION_MISMATCH",
};

/**
 * POST /api/stripe/webhook — OPTIONAL backstop (set `STRIPE_WEBHOOK_SECRET`); payment is normally
 * confirmed without it via POST /api/orders/{id}/confirm. Catches buyers who close the tab before the
 * redirect and delayed payment methods. Paid sessions go through the same `applyPaidCheckoutSession`
 * rules. Verifies the signature over the raw body (400 bad signature, 503 `STRIPE_WEBHOOK_SECRET` unset).
 * Safe under duplicate delivery: state changes are idempotent, and events that can never apply
 * (live mode, unknown order, amount mismatch, second payment of a paid order) are acknowledged with
 * 200 so Stripe stops retrying. Never logs the body.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  let event: Stripe.Event;
  try {
    event = verifyStripeWebhook(rawBody, req.headers.get("stripe-signature"));
  } catch (err) {
    if (err instanceof StripeWebhookError) {
      return jsonError(err.code === "WEBHOOK_NOT_CONFIGURED" ? 503 : 400, err.message, { code: err.code });
    }
    return internalError("POST /api/stripe/webhook", err);
  }

  // Test mode only: a live event must never move an order.
  if (event.livemode) return NextResponse.json({ received: true, ignored: true, reason: "livemode" });

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object;
        const result = await applyPaidCheckoutSession(session);
        if (result.outcome === "rejected") {
          if (result.reason === "order_not_found" || result.reason === "session_mismatch") {
            console.warn(`[stripe] webhook ${event.type} (${event.id}) not applied: ${REJECTION_REASON[result.reason]}`);
          }
          return NextResponse.json({ received: true, ignored: true, reason: REJECTION_REASON[result.reason] });
        }
        // `completed` with an async method (e.g. bank debit) arrives `unpaid`; wait for async_payment_succeeded.
        if (result.outcome === "not_paid_yet") {
          return NextResponse.json({ received: true, orderId: result.order.id, paymentStatus: "pending" });
        }
        return NextResponse.json({
          received: true,
          orderId: result.order.id,
          paymentStatus: result.order.paymentStatus,
          changed: result.changed,
        });
      }
      case "checkout.session.async_payment_failed": {
        const session = event.data.object;
        const orderId = orderIdOf(session);
        if (!orderId) return NextResponse.json({ received: true, ignored: true, reason: "no order reference" });
        const { order, changed } = await markOrderPaymentFailed({ orderId, sessionId: session.id });
        return NextResponse.json({ received: true, orderId, paymentStatus: order.paymentStatus, changed });
      }
      case "checkout.session.expired":
        // Abandoned checkout: the order stays `pending`; the next checkout click creates a fresh session.
        return NextResponse.json({ received: true, orderId: orderIdOf(event.data.object) });
      default:
        return NextResponse.json({ received: true, ignored: true });
    }
  } catch (err) {
    if (err instanceof OrderError) {
      console.warn(`[stripe] webhook ${event.type} (${event.id}) not applied: ${err.code}`);
      return NextResponse.json({ received: true, ignored: true, reason: err.code });
    }
    // Transient (e.g. DB down): 500 so Stripe retries the delivery.
    return internalError(`POST /api/stripe/webhook ${event.type}`, err);
  }
}
