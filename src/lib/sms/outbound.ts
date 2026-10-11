/**
 * Outbound SMS from the PingMarket service number to the real (Dial) buyer.
 * The `messages` row is written first and is the trace; the Dial send is one attempt and never throws.
 */
import { getDb, type Db } from "../db";
import { newUuidId } from "../db/ids";
import { messages } from "../db/schema";
import { getDialRuntime } from "../dial/runtime";
import type { Message } from "../types";
import type { SmsSendResult } from "./ports";

/** Prefix of `messages.dial_event_id` for texts we send through Dial. */
export const DIAL_OUTBOUND_PREFIX = "dial_out_";
/** Used for the trace row when Dial is not configured (local `/api/dial/simulate-inbound`). */
export const FALLBACK_SERVICE_NUMBER = "+15550000000";

export function toMessage(row: typeof messages.$inferSelect): Message {
  return {
    id: row.id,
    dialEventId: row.dialEventId,
    fromNumber: row.fromNumber,
    toNumber: row.toNumber,
    body: row.body,
    direction: row.direction,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Log-safe description of an error: name plus the database error code. Never the message, because
 * Drizzle query errors embed query parameters (phone numbers, message bodies).
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const code = (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" || typeof code === "number" ? `${err.name} (code ${code})` : err.name;
}

export function maskNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `…${digits.slice(-4)}` : "…";
}

export async function sendServiceSms(
  { to, body, from }: { to: string; body: string; from?: string },
  db?: Db,
): Promise<{ message: Message; result: SmsSendResult }> {
  const conn = db ?? (await getDb());
  const runtime = getDialRuntime();
  const [row] = await conn
    .insert(messages)
    .values({
      id: newUuidId("msg"),
      dialEventId: `${DIAL_OUTBOUND_PREFIX}${crypto.randomUUID()}`,
      fromNumber: from ?? runtime.serviceNumber ?? FALLBACK_SERVICE_NUMBER,
      toNumber: to,
      body,
      direction: "outbound",
    })
    .returning();

  let result: SmsSendResult;
  if (!runtime.sender) {
    result = { status: "blocked", reason: "disabled" };
    console.info(`[dial] send skipped to ${maskNumber(to)}: Dial not configured`);
  } else {
    try {
      result = await runtime.sender.send(to, body);
    } catch {
      result = { status: "unknown" };
    }
    if (result.status === "accepted") {
      console.info(`[dial] send accepted ${result.providerMessageId} to ${maskNumber(to)}`);
    } else if (result.status === "blocked") {
      console.info(`[dial] send blocked to ${maskNumber(to)}: ${result.reason}`);
    } else {
      console.info(`[dial] send unknown to ${maskNumber(to)}: check Dial message history before resending`);
    }
  }
  return { message: toMessage(row), result };
}
