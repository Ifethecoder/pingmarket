import { after, connection, NextResponse } from "next/server";
import { createDialWebhookHandler } from "@/lib/dial/webhook";
import { getDialRuntime, type DialRuntime } from "@/lib/dial/runtime";
import { processInboundSms } from "@/lib/sms/inbound";
import { createDbInbox } from "@/lib/sms/inbox";

// Node.js runtime (the default). `export const runtime` is rejected under `cacheComponents`.
// Processing runs in after(), which lives within this route's max duration (Darwin search can take ~20s).
export const maxDuration = 60;

type Handler = (request: Request) => Promise<Response>;
const handlers = new WeakMap<DialRuntime, Handler>();

/** One verified handler per process (per runtime config). Null when Dial can't receive. */
function handlerFor(dial: DialRuntime): Handler | null {
  if (!dial.configured || !dial.webhookSecret || !dial.serviceNumber || !dial.participantNumber) return null;
  let handle = handlers.get(dial);
  if (!handle) {
    handle = createDialWebhookHandler({
      signingSecret: dial.webhookSecret,
      serviceNumber: dial.serviceNumber,
      allowedParticipants: [dial.participantNumber],
      // Stored rows are processed after the 200: Dial times out at 10s and SEARCH can take ~20s.
      inbox: createDbInbox(undefined, (message) => {
        after(() => processInboundSms(message));
      }),
    });
    handlers.set(dial, handle);
  }
  return handle;
}

/**
 * POST /api/dial/webhook — signed Dial `message.received` events from the real buyer phone.
 * 200 `{ status: "stored" | "duplicate" | "ignored" }` once the text is durably in `messages`;
 * replies are routed and sent after the response. 503 `DIAL_NOT_CONFIGURED` without Dial env.
 */
export async function POST(req: Request) {
  const handle = handlerFor(getDialRuntime());
  if (!handle) return NextResponse.json({ error: "DIAL_NOT_CONFIGURED" }, { status: 503 });
  return handle(req);
}

/** GET /api/dial/webhook — health check, no secrets. */
export async function GET() {
  await connection();
  const dial = getDialRuntime();
  return NextResponse.json({ configured: dial.configured, webhookReady: dial.webhookReady, sendsEnabled: dial.sendsEnabled });
}
