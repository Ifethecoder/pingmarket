import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createListingRequestSchema, marketplaceIdSchema } from "@/lib/contracts";
import { internalError, parseJsonBody, validationError } from "@/lib/http";
import { createListing, listListings } from "@/lib/listings/service";
import type { ListingStatus } from "@/lib/types";

const LISTING_STATUSES = ["available", "reserved", "sold", "removed"] as const satisfies readonly ListingStatus[];

const listQuerySchema = z.object({
  marketplaceId: marketplaceIdSchema.optional(),
  status: z.enum(LISTING_STATUSES).optional(),
  sellerId: z.string().trim().min(1).max(80).optional(),
});

/** GET /api/listings?marketplaceId&status&sellerId — newest first. */
export async function GET(req: NextRequest) {
  const parsed = listQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return validationError(parsed.error, "Invalid query parameters");
  try {
    return NextResponse.json({ listings: await listListings(parsed.data) });
  } catch (err) {
    return internalError("GET /api/listings", err);
  }
}

/**
 * POST /api/listings — dev/demo tooling only (dashboard, curl).
 * Developer A's SMS router calls `createListing` from `@/lib/listings/service` directly.
 */
export async function POST(req: Request) {
  const parsedBody = await parseJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = createListingRequestSchema.safeParse(parsedBody.body);
  if (!parsed.success) return validationError(parsed.error);
  try {
    return NextResponse.json({ listing: await createListing(parsed.data) }, { status: 201 });
  } catch (err) {
    return internalError("POST /api/listings", err);
  }
}
