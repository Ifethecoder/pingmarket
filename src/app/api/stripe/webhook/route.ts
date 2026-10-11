import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { internalError, jsonError } from "@/lib/http";
import { getOrder, markOrderPaid, markOrderPaymentFailed, OrderError } from "@/lib/orders/service";
import { StripeWebhookError, verifyStripeWebhook } from "@/lib/payments/stripe";

function orderIdOf(session: Stripe.Checkout.Session): string | null {
  return session.client_reference_id ?? session.metadata?.orderId ?? null;
}

/**
 * POST /api/stripe/webhook — the ONLY path that marks an order `paid`.
 * Verifies the signature over the raw body (400 bad signature, 503 `STRIPE_WEBHOOK_SECRET` unset).
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
        const orderId = orderIdOf(session);
        if (!orderId) return NextResponse.json({ received: true, ignored: true, reason: "no order reference" });
        // `completed` with an async method (e.g. bank debit) arrives `unpaid`; wait for async_payment_succeeded.
        if (session.payment_status !== "paid") {
          return NextResponse.json({ received: true, orderId, paymentStatus: "pending" });
        }
        const existing = await getOrder(orderId);
        if (!existing) throw new OrderError("ORDER_NOT_FOUND", `Order ${orderId} not found`);
        if (session.amount_total !== existing.amountCents || session.currency !== "usd") {
          console.error(
            `[stripe] webhook ${event.id}: amount mismatch for order ${orderId} session ${session.id}: ` +
              `paid ${session.amount_total} ${session.currency}, expected ${existing.amountCents} usd`,
          );
          return NextResponse.json({ received: true, ignored: true, reason: "amount_mismatch" });
        }
        const { order, changed } = await markOrderPaid({ orderId, sessionId: session.id });
        return NextResponse.json({ received: true, orderId, paymentStatus: order.paymentStatus, changed });
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
