/**
 * Simulated SMS phones for the demo at `/sim`: one seller handset and one buyer handset.
 *
 * A thin wrapper over the shared router in `./gateway.ts` (the same one the real Dial buyer uses):
 * each inbound text and every reply is written to `messages` with a `sim_` Dial event id so the trace
 * feed can label it, and simulated rows never use a real Dial number.
 *
 * Identity is fixed, not inferred from the text:
 *   seller → seeded `u_seller_2` (NOT `u_seller_demo`, the dashboard demo seller)
 *   buyer  → seeded `u_web_buyer` (offers keep `source: "web_simulated"`)
 *
 * Negotiation (ACCEPT / COUNTER / DECLINE) defaults to the drizzle service in
 * `../negotiation/db-service.ts`; pass `negotiation` to substitute another `NegotiationPort`.
 */
import { and, asc, eq, like, or } from "drizzle-orm";
import { getDb, type Db } from "../db";
import { newUuidId } from "../db/ids";
import { messages, users } from "../db/schema";
import { WEB_BUYER_ID } from "../offers/service";
import type { RunSearchOptions } from "../search/service";
import type { MarketplaceId, Message } from "../types";
import { createSessionStore, routeSms, type NegotiationPort, type OutboundSms, type SmsSessionStore } from "./gateway";
import { toMessage } from "./outbound";

export type { NegotiationPort } from "./gateway";
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

export interface SimulateSmsInput {
  actor: SimActor;
  body: string;
  /** Marketplace whose number this handset is texting; used for SELL and SEARCH. Default `furniture`. */
  marketplaceId?: MarketplaceId;
}

export interface SimulateSmsOptions {
  db?: Db;
  search?: Omit<RunSearchOptions, "db">;
  /** Defaults to the drizzle negotiation service. */
  negotiation?: NegotiationPort;
  now?: () => number;
}

export interface SimulateSmsResult {
  inbound: Message;
  /** Replies to the sender plus any notification sent to the other handset. */
  outbound: Message[];
}

// Per-handset conversation state (listing drafts, last search), keyed by handset number. In-memory on
// purpose: this is a demo simulator. Memoized on globalThis so Next dev hot reloads keep it.
const globalForSim = globalThis as typeof globalThis & { __pingmarketSimSessionStore?: SmsSessionStore };
const sessions = (globalForSim.__pingmarketSimSessionStore ??= createSessionStore());

/** Test hook: forget drafts and cached searches. */
export function resetSimSessions(): void {
  sessions.clear();
}

export async function getSimHandset(actor: SimActor, db?: Db): Promise<SimHandset> {
  const conn = db ?? (await getDb());
  const { userId, fallbackNumber } = SIM_USERS[actor];
  const [row] = await conn.select({ phone: users.phone }).from(users).where(eq(users.id, userId)).limit(1);
  return { actor, userId, number: row?.phone ?? fallbackNumber };
}

/** Oldest first: every simulated message sent from or to this handset. */
export async function listSimThread(actor: SimActor, db?: Db, limit = 200): Promise<Message[]> {
  const conn = db ?? (await getDb());
  const handset = await getSimHandset(actor, conn);
  const rows = await conn
    .select()
    .from(messages)
    .where(
      and(
        like(messages.dialEventId, `${SIM_EVENT_PREFIX}%`),
        or(eq(messages.fromNumber, handset.number), eq(messages.toNumber, handset.number)),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(limit);
  return rows.map(toMessage);
}

/**
 * Records an inbound simulated text, routes it, and records every outbound reply.
 * Resolves with the stored rows so the UI can render them without a second fetch.
 */
export async function simulateSms(input: SimulateSmsInput, opts: SimulateSmsOptions = {}): Promise<SimulateSmsResult> {
  const db = opts.db ?? (await getDb());
  const now = opts.now?.() ?? Date.now();
  const [handset, other] = await Promise.all([
    getSimHandset(input.actor, db),
    getSimHandset(input.actor === "seller" ? "buyer" : "seller", db),
  ]);
  const [inboundRow] = await db
    .insert(messages)
    .values({
      id: newUuidId("msg"),
      dialEventId: newUuidId(SIM_EVENT_PREFIX.slice(0, -1)),
      fromNumber: handset.number,
      toNumber: SIM_SERVICE_NUMBER,
      body: input.body,
      direction: "inbound",
    })
    .returning();

  let outbound: OutboundSms[];
  try {
    ({ replies: outbound } = await routeSms({
      db,
      actor: {
        userId: handset.userId,
        number: handset.number,
        role: input.actor,
        source: "web_simulated",
        channel: "sim",
      },
      counterpart: { userId: other.userId, number: other.number },
      marketplaceId: input.marketplaceId ?? "furniture",
      session: sessions.get(handset.number, now),
      body: input.body,
      opts: { search: opts.search, negotiation: opts.negotiation },
    }));
  } catch (err) {
    console.error("[sms-sim] router failed", err);
    outbound = [{ to: handset.number, body: "Something went wrong on our side. Please try again." }];
  }

  const outboundRows: Message[] = [];
  for (const o of outbound) {
    const [row] = await db
      .insert(messages)
      .values({
        id: newUuidId("msg"),
        dialEventId: newUuidId(SIM_EVENT_PREFIX.slice(0, -1)),
        fromNumber: SIM_SERVICE_NUMBER,
        toNumber: o.to,
        body: o.body,
        direction: "outbound",
      })
      .returning();
    outboundRows.push(toMessage(row));
  }
  return { inbound: toMessage(inboundRow), outbound: outboundRows };
}
