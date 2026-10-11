import { NextResponse } from "next/server";
import { searchRequestSchema } from "@/lib/contracts";
import { internalError, jsonError, parseJsonBody, validationError } from "@/lib/http";
import { runSearch, SearchError } from "@/lib/search/service";

/**
 * POST /api/search — native listings + Darwin capabilities (PRD §8). Body: `SearchRequest`.
 * Follow-up: include `previousResponseId` (an earlier `darwin.responseId`) to continue that Darwin search.
 */
export async function POST(req: Request) {
  const parsedBody = await parseJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = searchRequestSchema.safeParse(parsedBody.body);
  if (!parsed.success) return validationError(parsed.error);
  try {
    return NextResponse.json(await runSearch(parsed.data));
  } catch (err) {
    if (err instanceof SearchError) return jsonError(400, err.message, { code: err.code });
    return internalError("POST /api/search", err);
  }
}
