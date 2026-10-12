/**
 * The two /sim demo handsets and the rows PingMarket writes for them. A simulated text is only a
 * `messages` row (`sim_` event id, fake service number); nothing here talks to Dial.
 *
 * Identity is fixed, not inferred from the text:
 *   seller → seeded `u_seller_2` (NOT `u_seller_demo`, the dashboard demo seller)
 *   buyer  → seeded `u_web_buyer` (offers keep `source: "web_simulated"`)
 */
import { eq } from "drizzle-orm";
import { getDb, type Db } from "../db";
import { newUuidId } from "../db/ids";
import { messages, users } from "../db/schema";
import { WEB_BUYER_ID } from "../offers/service";
import type { Message, MessageDirection } from "../types";
import { toMessage } from "./outbound";

export const SIM_ACTORS = ["seller", "buyer"] as const;
export type SimActor = (typeof SIM_ACTORS)[number];

/** Prefix of `messages.dial_event_id` for simulated rows; the trace feed labels these `SIM`. */
export const SIM_EVENT_PREFIX = "sim_";
/** Fake PingMarket service number used only by the simulator (never `DIAL_SERVICE_NUMBER`). */
export const SIM_SERVICE_NUMBER = "+15550000001";

const SIM_USERS: Record<SimActor, { userId: string; fallbackNumber: string }> = {
  seller: { userId: "u_seller_2", fallbackNumber: "+15550000003" },
  buyer: { userId: WEB_BUYER_ID, fallbackNumber: "+15550000010" },
};

export interface SimHandset {
  actor: SimActor;
  userId: string;
  number: string;
}

export async function getSimHandset(actor: SimActor, db?: Db): Promise<SimHandset> {
  const conn = db ?? (await getDb());
  const { userId, fallbackNumber } = SIM_USERS[actor];
  const [row] = await conn.select({ phone: users.phone }).from(users).where(eq(users.id, userId)).limit(1);
  return { actor, userId, number: row?.phone ?? fallbackNumber };
}

/** The /sim handset that plays `userId`, or null when that user has none. */
export async function simHandsetOfUser(userId: string, db?: Db): Promise<SimHandset | null> {
  const actor = SIM_ACTORS.find((a) => SIM_USERS[a].userId === userId);
  return actor ? getSimHandset(actor, db) : null;
}

// Strictly increasing timestamps for simulated rows: several texts written in the same millisecond
// (a reply, the other handset's notice, a competing decline) must keep their send order in the thread.
let lastSimAt = 0;
function nextSimTimestamp(): Date {
  lastSimAt = Math.max(Date.now(), lastSimAt + 1);
  return new Date(lastSimAt);
}

/** Stores one simulated text: `inbound` = handset → PingMarket, `outbound` = PingMarket → handset. */
export async function recordSimText(
  { handsetNumber, body, direction }: { handsetNumber: string; body: string; direction: MessageDirection },
  db?: Db,
): Promise<Message> {
  const conn = db ?? (await getDb());
  const [row] = await conn
    .insert(messages)
    .values({
      id: newUuidId("msg"),
      dialEventId: newUuidId(SIM_EVENT_PREFIX.slice(0, -1)),
      fromNumber: direction === "inbound" ? handsetNumber : SIM_SERVICE_NUMBER,
      toNumber: direction === "inbound" ? SIM_SERVICE_NUMBER : handsetNumber,
      body,
      direction,
      createdAt: nextSimTimestamp(),
    })
    .returning();
  return toMessage(row);
}
