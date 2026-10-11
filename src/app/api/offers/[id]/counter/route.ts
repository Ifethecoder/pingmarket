import { z } from "zod";
import { positiveCentsSchema } from "@/lib/contracts";
import { jsonError, parseJsonBody, zodIssues } from "@/lib/http";
import { dashboardOfferTransition, rejectCrossSite } from "@/lib/offers/transitions";

const counterSchema = z.object({ priceCents: positiveCentsSchema });

/**
 * POST /api/offers/{id}/counter `{ priceCents }` → `{ offer }`. The seller counters an `open` offer.
 * Errors: `{ error, code }` with 400 INVALID_PRICE, 403 FORBIDDEN (also a non-JSON content-type or a foreign Origin), 404 OFFER_NOT_FOUND,
 * 409 OFFER_CLOSED | OFFER_EXPIRED | LISTING_UNAVAILABLE. An SMS buyer is texted the counter.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = rejectCrossSite(req);
  if (refused) return refused;
  const { id } = await params;
  const parsedBody = await parseJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = counterSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return jsonError(400, "priceCents must be a positive integer number of cents", {
      code: "INVALID_PRICE",
      issues: zodIssues(parsed.error),
    });
  }
  return dashboardOfferTransition("counter", id, parsed.data.priceCents);
}
