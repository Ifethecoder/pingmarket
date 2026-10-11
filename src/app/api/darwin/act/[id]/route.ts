import { NextResponse } from "next/server";
import { actRequestIdSchema, getDarwinAct } from "@/lib/darwin/act";
import { DarwinError } from "@/lib/darwin/client";
import { internalError, jsonError } from "@/lib/http";
import { darwinActError } from "../errors";

/** GET /api/darwin/act/{actRequestId} — current thread state (messages, actions, pending requests). */
export async function GET(_req: Request, ctx: RouteContext<"/api/darwin/act/[id]">) {
  const { id } = await ctx.params;
  const parsed = actRequestIdSchema.safeParse(id);
  if (!parsed.success) return jsonError(400, "Not a Darwin actRequestId", { code: "INVALID_ACT_REQUEST_ID" });
  try {
    return NextResponse.json(await getDarwinAct(parsed.data));
  } catch (err) {
    if (err instanceof DarwinError) return darwinActError(err);
    return internalError("GET /api/darwin/act/[id]", err);
  }
}
