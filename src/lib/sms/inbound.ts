/**
 * Processes one stored inbound Dial SMS from the real buyer phone: resolve the user by phone, route the
 * text through the shared gateway (`./gateway.ts`), and text every reply back via Dial.
 * Runs after the webhook's 200 (Dial times out at 10s; a Darwin search can take ~20s).
 */
import { eq } from "drizzle-orm";
import { getDb, type Db } from "../db";
import { users } from "../db/schema";
import type { Message } from "../types";
import { createSessionStore, routeSms, type SmsRouterOptions, type SmsSessionStore } from "./gateway";
import { describeError, sendServiceSms } from "./outbound";

export const NOT_REGISTERED_TEXT = "This number isn't registered with PingMarket.";
export const GENERIC_FAILURE_TEXT = "Something went wrong on our side. Please try again.";

const globalForInbound = globalThis as typeof globalThis & { __pingmarketDialSessionStore?: SmsSessionStore };
const sessions = (globalForInbound.__pingmarketDialSessionStore ??= createSessionStore());

/** Test hook: forget per-phone drafts and cached searches. */
export function resetDialSessions(): void {
  sessions.clear();
}

// Per-phone promise chains: texts from one phone are processed in arrival order ("SEARCH …" then
// "AGENT 1"), while different phones run concurrently. Memoized on globalThis for Next dev reloads.
const globalForChains = globalThis as typeof globalThis & { __pingmarketDialChains?: Map<string, Promise<unknown>> };
const chains = (globalForChains.__pingmarketDialChains ??= new Map());

function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(work, work);
  const tail = run.catch(() => undefined);
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

export function processInboundSms(
  message: Message,
  opts: SmsRouterOptions & { db?: Db; now?: () => number } = {},
): Promise<Message[]> {
  return serialized(message.fromNumber, () => processNow(message, opts));
}

async function processNow(message: Message, opts: SmsRouterOptions & { db?: Db; now?: () => number }): Promise<Message[]> {
  const from = message.fromNumber;
  let db: Db | undefined = opts.db;
  const send = async (body: string) => (await sendServiceSms({ to: from, body, from: message.toNumber }, db)).message;
  try {
    db ??= await getDb();
    const conn = db;
    const [user] = await conn.select().from(users).where(eq(users.phone, from)).limit(1);
    if (!user) return [await send(NOT_REGISTERED_TEXT)];
    if (user.role !== "buyer") return [await send("This number isn't registered as a PingMarket buyer.")];
    // Texting us again after STOP is a fresh opt-in for replies and offer updates.
    if (user.consentStatus === "opted_out" && !/^\s*stop\s*$/i.test(message.body)) {
      await conn.update(users).set({ consentStatus: "opted_in" }).where(eq(users.id, user.id));
    }
    const { replies } = await routeSms({
      db: conn,
      actor: { userId: user.id, number: from, role: "buyer", source: "sms", channel: "dial" },
      marketplaceId: "furniture",
      session: sessions.get(from, opts.now?.() ?? Date.now()),
      body: message.body,
      opts: { search: opts.search, negotiation: opts.negotiation },
    });
    const sent: Message[] = [];
    for (const r of replies) sent.push((await sendServiceSms({ to: r.to, body: r.body, from: message.toNumber }, conn)).message);
    return sent;
  } catch (err) {
    // Log name/code only: database error messages embed query parameters (phone numbers).
    console.error(`[dial] processing inbound ${message.id} failed: ${describeError(err)}`);
    try {
      return [await send(GENERIC_FAILURE_TEXT)];
    } catch (sendErr) {
      console.error(`[dial] could not record failure reply for ${message.id}: ${describeError(sendErr)}`);
      return [];
    }
  }
}
