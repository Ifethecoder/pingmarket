import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, validationError } from "@/lib/http";
import { paymentErrorResponse } from "@/lib/payments/route-errors";
import { confirmOrderPayment } from "@/lib/payments/stripe";

const MAX_BODY_BYTES = 4096;

const confirmSchema = z.object({
  sessionId: z
    .string()
    .regex(/^cs_(test|live)_[A-Za-z0-9]+$/, "sessionId must be a Checkout Session id (cs_test_…)")
    .optional(),
});

/**
 * POST /api/orders/{id}/confirm, optional body `{ sessionId? }` → `{ order, confirmed, sessionStatus, paymentStatus, reason? }`.
 * Reads the Checkout Session from Stripe with the secret key and marks the order paid only if Stripe
 * says it is paid (test mode, same order, same amount, usd). No webhook needed; the redirect URL alone
 * proves nothing. 404 `ORDER_NOT_FOUND` / `SESSION_NOT_FOUND`, 409 `SESSION_MISMATCH`,
 * 503 `STRIPE_NOT_CONFIGURED`, 400 `STRIPE_INVALID_REQUEST`, 502 `STRIPE_ERROR`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return jsonError(413, "Request body too large");
  let body: unknown = {};
  if (raw.trim()) {
    try {
      body = JSON.parse(raw);
    } catch {
      return jsonError(400, "Request body must be valid JSON");
    }
  }
  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);
  try {
    return NextResponse.json(await confirmOrderPayment(id, { sessionId: parsed.data.sessionId }));
  } catch (err) {
    return paymentErrorResponse("POST /api/orders/[id]/confirm", err);
  }
}
