import { NextResponse } from "next/server";
import { internalError, jsonError } from "@/lib/http";
import { getListing } from "@/lib/listings/service";

/** GET /api/listings/{id} */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const listing = await getListing(id);
    if (!listing) return jsonError(404, `Listing ${id} not found`);
    return NextResponse.json({ listing });
  } catch (err) {
    return internalError("GET /api/listings/[id]", err);
  }
}
