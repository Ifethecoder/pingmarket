import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { marketplaceIdSchema } from "@/lib/contracts";
import { internalError, parseJsonBody, validationError } from "@/lib/http";
import {
  getSimHandset,
  listSimThread,
  SIM_ACTORS,
  SIM_SERVICE_NUMBER,
  simulateSms,
} from "@/lib/sms/simulator";

const actorQuerySchema = z.object({ actor: z.enum(SIM_ACTORS) });

const postSchema = z.object({
  actor: z.enum(SIM_ACTORS),
  body: z.string().trim().min(1).max(2000),
  marketplaceId: marketplaceIdSchema.optional(),
});

/** GET /api/sms/simulate?actor=seller|buyer — that handset's simulated thread, oldest first. */
export async function GET(req: NextRequest) {
  const parsed = actorQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return validationError(parsed.error, "Invalid query parameters");
  try {
    const [handset, messages] = await Promise.all([getSimHandset(parsed.data.actor), listSimThread(parsed.data.actor)]);
    return NextResponse.json({ handset, serviceNumber: SIM_SERVICE_NUMBER, messages });
  } catch (err) {
    return internalError("GET /api/sms/simulate", err);
  }
}

/**
 * POST /api/sms/simulate — a simulated handset texts PingMarket. The body is parsed with the SMS
 * grammar and routed into the listings / search / offers services; replies are stored in `messages`.
 * Identity comes from `actor`, never from the text. Nothing here talks to Dial.
 */
export async function POST(req: Request) {
  const parsedBody = await parseJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = postSchema.safeParse(parsedBody.body);
  if (!parsed.success) return validationError(parsed.error);
  try {
    return NextResponse.json(await simulateSms(parsed.data), { status: 201 });
  } catch (err) {
    return internalError("POST /api/sms/simulate", err);
  }
}
