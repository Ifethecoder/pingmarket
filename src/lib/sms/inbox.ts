/**
 * Durable Dial inbox: each verified inbound SMS becomes a `messages` row keyed by its Dial event id.
 * `messages.dial_event_id` is unique, so a retried webhook delivery is reported as a duplicate and never
 * processed twice. Processing itself is scheduled by the caller via `onStored` (after the 200).
 */
import { getDb, type Db } from "../db";
import { newUuidId } from "../db/ids";
import { messages } from "../db/schema";
import type { Message } from "../types";
import { toMessage } from "./outbound";
import type { ReceivedSms, SmsInbox } from "./ports";

export function createDbInbox(db?: Db, onStored?: (message: Message) => void | Promise<void>): SmsInbox {
  return {
    async receive(received: ReceivedSms) {
      const conn = db ?? (await getDb());
      const [row] = await conn
        .insert(messages)
        .values({
          id: newUuidId("msg"),
          dialEventId: received.eventId,
          fromNumber: received.from,
          toNumber: received.to,
          body: received.body,
          direction: "inbound",
        })
        .onConflictDoNothing({ target: messages.dialEventId })
        .returning();
      if (!row) return "duplicate";
      await onStored?.(toMessage(row));
      return "stored";
    },
  };
}
