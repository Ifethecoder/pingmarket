import type { NextResponse } from "next/server";
import type { DarwinError } from "@/lib/darwin/client";
import { jsonError } from "@/lib/http";

/** Maps a Darwin Act failure to `{ error, code }`. `error` is the plain-language explanation when we have one. */
export function darwinActError(err: DarwinError): NextResponse {
  if (err.code === "NOT_CONFIGURED") return jsonError(503, err.message, { code: err.code });
  const details = err.details as { code?: string; explanation?: string | null } | undefined;
  const status = err.code === "RATE_LIMITED" ? 429 : err.status && err.status < 500 ? 400 : 502;
  return jsonError(status, details?.explanation ?? err.message, { code: details?.code ?? err.code });
}
