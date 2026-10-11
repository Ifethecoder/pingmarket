import type { ReceivedSms, SmsInbox } from "../sms/ports.ts";
import { verifyDialSignature } from "./signature.ts";

export const isE164 = (value: string) => /^\+[1-9]\d{7,14}$/.test(value);
const MAX_BYTES = 64 * 1024;
type Options = {
  signingSecret: string;
  serviceNumber: string;
  allowedParticipants: readonly string[];
  inbox: SmsInbox;
  now?: () => number;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function shortString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}
function response(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status });
}

/** Framework-neutral; wire into B's app only after supplying a durable inbox. */
export function createDialWebhookHandler(options: Options) {
  if (!options.signingSecret || !isE164(options.serviceNumber) ||
      options.allowedParticipants.length === 0 ||
      options.allowedParticipants.some((number) => !isE164(number) || number === options.serviceNumber)) {
    throw new Error("Invalid Dial webhook configuration");
  }
  const allowedParticipants = new Set(options.allowedParticipants);
  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return response(405, { error: "method_not_allowed" });
    const reader = request.body?.getReader();
    if (!reader) return response(400, { error: "missing_body" });
    let rawBody: Uint8Array;
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          return response(413, { error: "body_too_large" });
        }
        chunks.push(value);
      }
      rawBody = Buffer.concat(chunks);
    } catch { return response(400, { error: "invalid_body" }); }
    finally { reader.releaseLock(); }

    if (!verifyDialSignature(rawBody, request.headers.get("x-dial-signature"), options.signingSecret, options.now?.())) {
      return response(401, { error: "invalid_signature" });
    }
    let event: unknown;
    try { event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)); }
    catch { return response(400, { error: "invalid_json" }); }
    if (!record(event) || !shortString(event.id) || !shortString(event.type) ||
        event.object !== "event" || event.version !== 1 ||
        typeof event.createdAt !== "string" || !Number.isFinite(Date.parse(event.createdAt)) ||
        event.id !== request.headers.get("x-dial-event-id") ||
        event.type !== request.headers.get("x-dial-event-type")) {
      return response(400, { error: "invalid_event" });
    }
    // Signed pings and unrelated events never enter the marketplace router.
    if (event.type !== "message.received") return response(200, { status: "ignored" });
    const data = event.data;
    if (!record(data) || !shortString(data.messageId) ||
        typeof data.from !== "string" || !isE164(data.from) ||
        typeof data.to !== "string" || !isE164(data.to) ||
        typeof data.body !== "string" || data.body.length > 4000) {
      return response(400, { error: "invalid_message" });
    }
    // Account-wide subscriptions may also see our reply received at Number B.
    if (data.to !== options.serviceNumber || !allowedParticipants.has(data.from)) {
      return response(200, { status: "ignored" });
    }
    const message: ReceivedSms = {
      eventId: event.id,
      messageId: data.messageId,
      from: data.from,
      to: data.to,
      body: data.body,
      occurredAt: event.createdAt,
      source: "dial_sms",
      providerSource: data.source === "internal" || data.source === "external" ? data.source : "unknown",
    };
    try {
      const status = await options.inbox.receive(message);
      return response(200, { status });
    } catch {
      // A non-2xx lets Dial retry; never return success before durable receipt.
      return response(503, { error: "inbox_unavailable" });
    }
  };
}
