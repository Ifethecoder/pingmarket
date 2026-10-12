/**
 * Simulated SMS phones for the demo at `/sim`: one seller handset and one buyer handset.
 *
 * A thin wrapper over the shared router in `./gateway.ts` (the same one the real Dial buyer uses):
 * each inbound text and every reply is written to `messages` with a `sim_` Dial event id so the trace
 * feed can label it, and simulated rows never use a real Dial number.
 *
 * Identity is fixed, not inferred from the text (see `./sim-handsets.ts`). Texts to these handsets from
 * outside the simulator (dashboard transitions, payments, payouts) arrive through `./deliver.ts`.
 *
 * Negotiation (ACCEPT / COUNTER / DECLINE) defaults to the drizzle service in
 * `../negotiation/db-service.ts`; pass `negotiation` to substitute another `NegotiationPort`.
 */
import { and, asc, eq, like, or } from "drizzle-orm";
import { getDb, type Db } from "../db";
import { messages } from "../db/schema";
import type { RunSearchOptions } from "../search/service";
import type { MarketplaceId, Message } from "../types";
import { createSessionStore, routeSms, type NegotiationPort, type OutboundSms, type SmsSessionStore } from "./gateway";
import { toMessage } from "./outbound";
import { getSimHandset, recordSimText, SIM_EVENT_PREFIX, type SimActor } from "./sim-handsets";

export type { NegotiationPort } from "./gateway";
export {
  getSimHandset,
  SIM_ACTORS,
  SIM_EVENT_PREFIX,
  SIM_SERVICE_NUMBER,
  type SimActor,
  type SimHandset,
} from "./sim-handsets";

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
  const inbound = await recordSimText({ handsetNumber: handset.number, body: input.body, direction: "inbound" }, db);

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
    outboundRows.push(await recordSimText({ handsetNumber: o.to, body: o.body, direction: "outbound" }, db));
  }
  return { inbound, outbound: outboundRows };
}
