import { NextResponse } from "next/server";
import { z } from "zod";
import { isE164 } from "@/lib/dial/webhook";
import { getDialRuntime } from "@/lib/dial/runtime";
import { jsonError, parseJsonBody, validationError } from "@/lib/http";
import type { Message } from "@/lib/types";
import { processInboundSms } from "@/lib/sms/inbound";
import { createDbInbox } from "@/lib/sms/inbox";
import { describeError, FALLBACK_SERVICE_NUMBER } from "@/lib/sms/outbound";

// Node.js runtime (the default). `export const runtime` is rejected under `cacheComponents`.

const bodySchema = z.object({
  from: z.string().trim().refine(isE164, "from must be an E.164 phone number"),
  body: z.string().trim().min(1).max(2000),
});

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Only a direct local call may use this helper. The dev server is also reachable through the public
 * cloudflared tunnel (where NODE_ENV is still "development"), so require: a localhost Host header, no
 * tunnel/proxy client address, and a JSON content-type (which a cross-site form cannot send).
 * Next itself fills in `x-forwarded-for` with the socket address when absent (base-server.js), so a
 * direct local call carries a loopback XFF; a tunnel or proxy sets the real client IP there (and
 * Cloudflare adds `cf-connecting-ip`).
 */
function isDirectLocalRequest(req: Request): boolean {
  if (req.headers.has("cf-connecting-ip")) return false;
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor !== null && !forwardedFor.split(",").every((hop) => LOOPBACK_ADDRESSES.has(hop.trim()))) return false;
  const contentType = req.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return false;
  const host = req.headers.get("host") ?? new URL(req.url).host;
  try {
    return LOCAL_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/**
 * POST /api/dial/simulate-inbound `{ from, body }` — local development only: 404 in production and for
 * any request that is not a direct localhost JSON call (tunnel, proxy, cross-site form).
 * Feeds a text through the same inbox + processing path as the Dial webhook, synchronously, and returns
 * the stored rows. Replies are still sent through Dial when it is configured and sends are enabled.
 */
export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production" || !isDirectLocalRequest(req)) return jsonError(404, "Not found");
  const parsedBody = await parseJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = bodySchema.safeParse(parsedBody.body);
  if (!parsed.success) return validationError(parsed.error);
  try {
    const stored: Message[] = [];
    const inbox = createDbInbox(undefined, (message) => {
      stored.push(message);
    });
    const eventId = `dev_${crypto.randomUUID()}`;
    await inbox.receive({
      eventId,
      messageId: eventId,
      from: parsed.data.from,
      to: getDialRuntime().serviceNumber ?? FALLBACK_SERVICE_NUMBER,
      body: parsed.data.body,
      occurredAt: new Date().toISOString(),
      source: "dial_sms",
      providerSource: "unknown",
    });
    const [inbound] = stored;
    if (!inbound) throw new Error("simulated inbound was not stored");
    const outbound = await processInboundSms(inbound);
    return NextResponse.json({ inbound, outbound }, { status: 201 });
  } catch (err) {
    // Log name/code only: database error messages embed query parameters (phone numbers).
    console.error(`[api] POST /api/dial/simulate-inbound failed: ${describeError(err)}`);
    return jsonError(500, "Internal error");
  }
}
