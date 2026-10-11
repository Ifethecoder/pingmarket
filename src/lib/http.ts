/** Small helpers shared by App Router route handlers. */
import { NextResponse } from "next/server";
import type { z } from "zod";

export interface ApiIssue {
  path: string;
  message: string;
}

export function jsonError(status: number, error: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error, ...extra }, { status });
}

export function zodIssues(err: z.ZodError): ApiIssue[] {
  return err.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}

/** 400 response for a failed zod parse. */
export function validationError(err: z.ZodError, error = "Invalid request"): NextResponse {
  return jsonError(400, error, { issues: zodIssues(err) });
}

/** 500 response; logs the real error server-side only. */
export function internalError(context: string, err: unknown): NextResponse {
  console.error(`[api] ${context}`, err);
  return jsonError(500, "Internal error");
}

const MAX_BODY_BYTES = 65_536;

export async function parseJsonBody(
  req: Request,
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  if (Number(req.headers.get("content-length")) > MAX_BODY_BYTES) {
    return { ok: false, response: jsonError(413, "Request body too large") };
  }
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false, response: jsonError(400, "Request body must be valid JSON") };
  }
}
