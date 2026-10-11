import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { actStartRequestSchema, startDarwinAct, wasReturnedBySearch } from "@/lib/darwin/act";
import { DarwinError } from "@/lib/darwin/client";
import { internalError, jsonError, parseJsonBody, validationError } from "@/lib/http";
import { darwinActError } from "./errors";

/**
 * POST /api/darwin/act — send one text message to an agent Darwin returned in a stored search.
 * Body: `{ searchId, agentId, capabilityId, message }`. Returns a `DarwinActView`.
 * PingMarket never answers payment, approval, or authentication requests from the provider.
 */
export async function POST(req: Request) {
  const parsedBody = await parseJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = actStartRequestSchema.safeParse(parsedBody.body);
  if (!parsed.success) return validationError(parsed.error);
  const { searchId, agentId, capabilityId, message } = parsed.data;

  try {
    const db = await getDb();
    if (!(await wasReturnedBySearch(db, searchId, { agentId, capabilityId }))) {
      return jsonError(400, "This agent was not returned by that Darwin search on this server.", {
        code: "UNKNOWN_SEARCH_AGENT",
      });
    }
    return NextResponse.json(await startDarwinAct({ agentId, capabilityId }, message));
  } catch (err) {
    if (err instanceof DarwinError) return darwinActError(err);
    return internalError("POST /api/darwin/act", err);
  }
}
