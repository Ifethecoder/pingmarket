/**
 * Dashboard (seller console) offer transitions behind POST /api/offers/{id}/counter|accept|decline.
 * The actor is derived server-side from the offer, never from the request body:
 *   counter            → the seller
 *   accept / decline   → the seller while `open`; the buyer while `countered` — except an SMS buyer,
 *                        who must answer from their phone (409 `SMS_BUYER_ONLY`).
 * After a transition the other side's phone is texted: the real SMS buyer, or the /sim buyer / seller
 * handset, plus the buyers of competing offers an accept declined (see `../sms/notify.ts`).
 */
import { NextResponse } from "next/server";
import { jsonError } from "../http";
import {
  acceptOffer,
  counterOffer,
  declineOffer,
  NEGOTIATION_ERROR_STATUS,
  NegotiationError,
} from "../negotiation/db-service";
import { notifyTransition } from "../sms/notify";
import { describeError } from "../sms/outbound";
import { getOffer } from "./service";

export type DashboardAction = "counter" | "accept" | "decline";

/**
 * CSRF guard for the state-changing offer routes: a cross-site HTML form can't send
 * `content-type: application/json`, and a browser always sends `Origin` on cross-origin POSTs.
 * Returns a 403 response to send, or null when the request may proceed.
 */
export function rejectCrossSite(req: Request): NextResponse | null {
  const contentType = req.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return jsonError(403, "Content-Type must be application/json", { code: "FORBIDDEN" });
  }
  const origin = req.headers.get("origin");
  if (origin !== null) {
    const ownHost = req.headers.get("host") ?? new URL(req.url).host;
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost !== ownHost && origin !== new URL(req.url).origin) {
      return jsonError(403, "Cross-origin request refused", { code: "FORBIDDEN" });
    }
  }
  return null;
}

export async function dashboardOfferTransition(
  action: DashboardAction,
  offerId: string,
  priceCents?: number,
): Promise<NextResponse> {
  const context = `POST /api/offers/[id]/${action}`;
  try {
    const current = await getOffer(offerId);
    if (!current) {
      return jsonError(NEGOTIATION_ERROR_STATUS.OFFER_NOT_FOUND, `Offer ${offerId} not found`, { code: "OFFER_NOT_FOUND" });
    }
    // Repeated accept (e.g. a double click): return it as is, no transition, no second text.
    if (action === "accept" && current.status === "accepted") return NextResponse.json({ offer: current });

    let actorId = current.sellerId;
    if (action !== "counter" && current.status === "countered") {
      if (current.source === "sms") {
        return jsonError(
          NEGOTIATION_ERROR_STATUS.SMS_BUYER_ONLY,
          `Offer ${current.id} is waiting on the SMS buyer, who must reply ${action.toUpperCase()} ${current.id} from their phone`,
          { code: "SMS_BUYER_ONLY" },
        );
      }
      actorId = current.buyerId;
    }

    const { offer, changed, declined } =
      action === "counter"
        ? await counterOffer({ offerId, actorId, priceCents: priceCents! })
        : action === "accept"
          ? await acceptOffer({ offerId, actorId })
          : await declineOffer({ offerId, actorId });

    // The other side's phone (real SMS buyer, or a /sim handset) hears about it; never fails the request.
    if (changed) await notifyTransition({ offer, actorId, declined });
    return NextResponse.json({ offer });
  } catch (err) {
    if (err instanceof NegotiationError) {
      return jsonError(NEGOTIATION_ERROR_STATUS[err.code], err.message, { code: err.code });
    }
    // Not `internalError`: database error messages embed query parameters (phone numbers).
    console.error(`[api] ${context} failed: ${describeError(err)}`);
    return jsonError(500, "Internal error");
  }
}
