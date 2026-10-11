import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify exact bytes, not parsed/re-serialized JSON. No credentials in errors. */
export function verifyDialSignature(
  rawBody: Uint8Array,
  header: string | null,
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (!header || !secret || !Number.isFinite(nowMs)) return false;
  const match = /^t=(\d{1,12}),v1=([a-fA-F0-9]{64})$/.exec(header);
  if (!match || Math.abs(nowMs / 1000 - Number(match[1])) >= 300) return false;
  const expected = createHmac("sha256", secret)
    .update(`${match[1]}.`)
    .update(rawBody)
    .digest();
  return timingSafeEqual(expected, Buffer.from(match[2], "hex"));
}
