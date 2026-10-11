import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { internalError, jsonError, parseJsonBody, validationError } from "@/lib/http";
import { getOrCreateOrderForOffer, listOrders, ORDER_ERROR_STATUS, OrderError } from "@/lib/orders/service";

const createOrderSchema = z.object({
  offerId: z.string().trim().min(1).max(40),
});

/** GET /api/orders → `{ orders: Order[] }`, newest first. */
export async function GET() {
  // Always request-time: never prerender DB state at build (cacheComponents is on).
  await connection();
  try {
    return NextResponse.json({ orders: await listOrders() });
  } catch (err) {
    return internalError("GET /api/orders", err);
  }
}

/**
 * POST /api/orders `{ offerId }` → `{ order }`. Get-or-create for an accepted offer:
 * 201 when the order was created, 200 when it already existed (idempotent).
 */
export async function POST(req: Request) {
  const parsedBody = await parseJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = createOrderSchema.safeParse(parsedBody.body);
  if (!parsed.success) return validationError(parsed.error);
  try {
    const { order, created } = await getOrCreateOrderForOffer(parsed.data.offerId);
    return NextResponse.json({ order }, { status: created ? 201 : 200 });
  } catch (err) {
    if (err instanceof OrderError) {
      return jsonError(ORDER_ERROR_STATUS[err.code], err.message, { code: err.code });
    }
    return internalError("POST /api/orders", err);
  }
}
