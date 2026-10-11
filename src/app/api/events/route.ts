import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { listTraceEvents } from "@/lib/events/service";
import { internalError, validationError } from "@/lib/http";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** GET /api/events?limit=50 → `{ events: TraceEvent[] }`, newest first. */
export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse({ limit: req.nextUrl.searchParams.get("limit") ?? undefined });
  if (!parsed.success) return validationError(parsed.error, "Invalid query parameters");
  try {
    return NextResponse.json({ events: await listTraceEvents(parsed.data.limit) });
  } catch (err) {
    return internalError("GET /api/events", err);
  }
}
