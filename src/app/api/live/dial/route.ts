import { connection, NextResponse } from "next/server";
import { z } from "zod";
import { getDialRuntime } from "@/lib/dial/runtime";
import { maskPhone } from "@/lib/events/service";
import { jsonError, parseJsonBody, validationError } from "@/lib/http";
import { listLiveThread, type LiveMessage } from "@/lib/sms/live";
import { sendServiceSms } from "@/lib/sms/outbound";

export interface LiveDialResponse {
  configured: boolean;
  webhookReady: boolean;
  sendsEnabled: boolean;
  serviceNumber: string | null;
  participantNumber: string | null;
  messages: LiveMessage[];
}

/** Read-only connection status and real messages; never sends or registers a webhook. */
export async function GET() {
  await connection();
  const dial = getDialRuntime();
  const response: LiveDialResponse = {
    configured: dial.configured,
    webhookReady: dial.webhookReady,
    sendsEnabled: dial.sendsEnabled,
    serviceNumber: dial.serviceNumber,
    participantNumber: dial.participantNumber ? maskPhone(dial.participantNumber) : null,
    messages: await listLiveThread(dial.serviceNumber, dial.participantNumber),
  };
  return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
}

const sendSchema = z.object({
  side: z.enum(["buyer", "service"]),
  body: z.string().trim().min(1).max(1600),
});

/** Send from either live handset in the local live conversation UI. */
export async function POST(req: Request) {
  const parsedBody = await parseJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = sendSchema.safeParse(parsedBody.body);
  if (!parsed.success) return validationError(parsed.error);

  const dial = getDialRuntime();
  if (!dial.serviceNumber || !dial.participantNumber) return jsonError(503, "Dial participant is not configured");

  try {
    if (parsed.data.side === "service") {
      const result = await sendServiceSms({ to: dial.participantNumber, body: parsed.data.body });
      if (result.result.status !== "accepted") return jsonError(503, "Dial did not accept the message");
      return NextResponse.json({ message: result.message }, { status: 201 });
    }

    if (process.env.NODE_ENV === "production") return jsonError(404, "Buyer-side live typing is local development only");
    const response = await fetch(new URL("/api/dial/simulate-inbound", req.url), {
      method: "POST",
      headers: { "content-type": "application/json", host: new URL(req.url).host },
      body: JSON.stringify({ from: dial.participantNumber, body: parsed.data.body }),
    });
    if (!response.ok) return jsonError(503, "Could not process the buyer message");
    return NextResponse.json(await response.json(), { status: 201 });
  } catch {
    return jsonError(500, "Could not send the live message");
  }
}
