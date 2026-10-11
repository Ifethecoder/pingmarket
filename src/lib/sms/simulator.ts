/**
 * Simulated SMS phones for the demo at `/sim`: one seller handset and one buyer handset.
 *
 * Each inbound text is parsed with Developer A's `parseSms` grammar and routed into the real
 * listings / search / offers services, then the reply (and any notification to the other handset)
 * is written back to `messages`. Every simulated row carries a `sim_` Dial event id so the trace
 * feed can label it, and simulated rows never use a real Dial number.
 *
 * Identity is fixed, not inferred from the text:
 *   seller → seeded `u_seller_2` (NOT `u_seller_demo`, which is the real Dial Number B seller)
 *   buyer  → seeded `u_web_buyer` (offers keep `source: "web_simulated"`)
 *
 * Negotiation (ACCEPT / COUNTER / DECLINE) is Developer A's service: pass it as `negotiation`.
 * Without it, those commands reply that they are not wired yet and change nothing.
 */
import { and, asc, eq, like, or } from "drizzle-orm";
import { getDb, type Db } from "../db";
import { newUuidId } from "../db/ids";
import { messages, users } from "../db/schema";
import { createListing, getListing, ListingError, updateListingStatus } from "../listings/service";
import { createOffer, getOffer, OfferError, WEB_BUYER_ID } from "../offers/service";
import { runSearch, type RunSearchOptions } from "../search/service";
import type { Listing, MarketplaceId, Message, Offer, SearchResponse } from "../types";
import { clarifyListing, parseSms, type SmsIntent } from "./intent";
import type { ListingDraft } from "./ports";

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

export interface NegotiationPort {
  counter(input: { offerId: string; actorId: string; priceCents: number }, db: Db): Promise<Offer>;
  accept(input: { offerId: string; actorId: string }, db: Db): Promise<Offer>;
  decline(input: { offerId: string; actorId: string }, db: Db): Promise<Offer>;
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
  negotiation?: NegotiationPort;
  now?: () => number;
}

export interface SimulateSmsResult {
  inbound: Message;
  /** Replies to the sender plus any notification sent to the other handset. */
  outbound: Message[];
}

// ---------------------------------------------------------------------------
// Per-handset conversation state (listing drafts, last search). In-memory on purpose: this is a
// demo simulator, not the durable inbox Developer A's webhook needs. Memoized on globalThis so
// Next dev hot reloads keep it.
// ---------------------------------------------------------------------------

interface SimSession {
  draft?: ListingDraft;
  draftMarketplaceId?: MarketplaceId;
  lastSearch?: SearchResponse;
  touchedAt: number;
}

const SESSION_TTL_MS = 10 * 60 * 1000;
const globalForSim = globalThis as typeof globalThis & { __pingmarketSimSessions?: Map<SimActor, SimSession> };
const sessions = (globalForSim.__pingmarketSimSessions ??= new Map());

function session(actor: SimActor, now: number): SimSession {
  const existing = sessions.get(actor);
  if (existing && now - existing.touchedAt <= SESSION_TTL_MS) {
    existing.touchedAt = now;
    return existing;
  }
  const fresh: SimSession = { touchedAt: now };
  sessions.set(actor, fresh);
  return fresh;
}

/** Test hook: forget drafts and cached searches. */
export function resetSimSessions(): void {
  sessions.clear();
}

// ---------------------------------------------------------------------------

function toMessage(row: typeof messages.$inferSelect): Message {
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

function money(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
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

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

interface Outbound {
  to: string;
  body: string;
}

interface Ctx {
  db: Db;
  actor: SimActor;
  handset: SimHandset;
  other: SimHandset;
  marketplaceId: MarketplaceId;
  session: SimSession;
  opts: SimulateSmsOptions;
}

const HELP: Record<SimActor, string> = {
  seller: [
    "PingMarket seller commands:",
    "SELL item, $price, location[, details]",
    "DETAILS D2 · REMOVE D2",
    "ACCEPT O7 · COUNTER O7 90 · DECLINE O7",
    "HELP · CANCEL · STOP",
  ].join("\n"),
  buyer: [
    "PingMarket buyer commands:",
    "SEARCH office chair under $100 in Berkeley",
    "OFFER D2 80 · DETAILS D2 · AGENT 1",
    "ACCEPT O7 · DECLINE O7",
    "HELP · STOP",
  ].join("\n"),
};

const DRAFT_PROMPT: Record<"title" | "priceCents" | "location", string> = {
  title: "What are you selling?",
  priceCents: "What price? e.g. $120",
  location: "Where is it? e.g. Berkeley",
};

function reply(ctx: Ctx, body: string): Outbound {
  return { to: ctx.handset.number, body };
}

function describeListing(l: Listing): string {
  const where = l.location ? ` · ${l.location}` : "";
  return `${l.id} ${l.title} — ${money(l.priceCents, l.currency)}${where}`;
}

async function handleSell(ctx: Ctx, intent: Extract<SmsIntent, { type: "sell" }>): Promise<Outbound[]> {
  if (ctx.actor !== "seller") {
    return [reply(ctx, "This phone is the buyer handset. Switch to the seller phone to text SELL.")];
  }
  if (intent.missing.length) {
    ctx.session.draft = intent.draft;
    ctx.session.draftMarketplaceId ??= ctx.marketplaceId;
    return [reply(ctx, `${DRAFT_PROMPT[intent.missing[0]]} (or CANCEL)`)];
  }
  const marketplaceId = ctx.session.draftMarketplaceId ?? ctx.marketplaceId;
  ctx.session.draft = undefined;
  ctx.session.draftMarketplaceId = undefined;
  try {
    const listing = await createListing(
      {
        sellerId: ctx.handset.userId,
        marketplaceId,
        title: intent.draft.title!,
        priceCents: intent.draft.priceCents!,
        location: intent.draft.location ?? null,
        description: intent.draft.description ?? null,
      },
      ctx.db,
    );
    return [
      reply(
        ctx,
        `Listed ${describeListing(listing)}. Buyers across PingMarket can find it now. Reply DETAILS ${listing.id} or REMOVE ${listing.id}.`,
      ),
    ];
  } catch (err) {
    if (err instanceof ListingError) return [reply(ctx, `Couldn't list that: ${err.message}`)];
    throw err;
  }
}

async function handleSearch(ctx: Ctx, query: string): Promise<Outbound[]> {
  const resp = await runSearch({ query, marketplaceId: ctx.marketplaceId }, { ...ctx.opts.search, db: ctx.db });
  ctx.session.lastSearch = resp;
  const lines: string[] = [];
  const native = resp.nativeListings.slice(0, 3);
  if (native.length === 0) {
    lines.push(`No PingMarket listings matched "${truncate(query, 60)}".`);
  } else {
    lines.push(`${resp.nativeListings.length} listing${resp.nativeListings.length === 1 ? "" : "s"} for "${truncate(query, 60)}":`);
    native.forEach((l, i) => {
      const where = l.location ? ` · ${l.location}` : "";
      lines.push(`${i + 1}) ${l.id} ${l.title} — ${money(l.priceCents, l.currency)}${where}`);
    });
    lines.push(`Reply OFFER ${native[0].id} ${Math.max(1, Math.round((native[0].priceCents * 0.8) / 100))} to make an offer.`);
  }
  const { darwin } = resp;
  const agents = resp.externalCapabilities.slice(0, 3);
  if (agents.length) {
    lines.push(
      `Also ${resp.externalCapabilities.length} external agent${resp.externalCapabilities.length === 1 ? "" : "s"} via Darwin: ${agents
        .map((a, i) => `${i + 1}) ${truncate(a.name, 40)}`)
        .join(" ")}. Reply AGENT 1 for details.`,
    );
  } else if (darwin.status === "needs_input" && darwin.question) {
    lines.push(`Darwin asks: ${truncate(darwin.question, 200)}`);
  } else if (darwin.status === "error") {
    lines.push("External agent search is unavailable right now.");
  } else if (darwin.status === "no_match") {
    lines.push("No external agents matched.");
  }
  return [reply(ctx, lines.join("\n"))];
}

async function handleOffer(ctx: Ctx, listingCode: string, priceCents: number): Promise<Outbound[]> {
  if (ctx.actor !== "buyer") {
    return [reply(ctx, "This phone is the seller handset. Switch to the buyer phone to make an offer.")];
  }
  let offer: Offer;
  try {
    offer = await createOffer({ listingId: listingCode, priceCents, buyerId: ctx.handset.userId, source: "web_simulated" }, ctx.db);
  } catch (err) {
    if (err instanceof OfferError) {
      const text: Record<OfferError["code"], string> = {
        LISTING_NOT_FOUND: `No listing ${listingCode}. Reply SEARCH <item> to find one.`,
        LISTING_UNAVAILABLE: `${listingCode} is no longer available.`,
        INVALID_PRICE: "Use a positive price, e.g. OFFER D2 80.",
        BUYER_NOT_FOUND: "This buyer account is missing. Reseed the database.",
        SELF_OFFER: "You can't make an offer on your own listing.",
      };
      return [reply(ctx, text[err.code])];
    }
    throw err;
  }
  const listing = await getListing(offer.listingId, ctx.db);
  const title = listing ? ` (${listing.title}, asking ${money(listing.priceCents, listing.currency)})` : "";
  const out: Outbound[] = [];
  if (listing && listing.sellerId === ctx.other.userId) {
    out.push(
      reply(ctx, `Offer ${offer.id} sent: ${money(offer.proposedPriceCents)} for ${offer.listingId}${title}. We'll text you when the seller replies.`),
      {
        to: ctx.other.number,
        body: `New offer ${offer.id} on ${offer.listingId} (${listing.title}): ${money(offer.proposedPriceCents)}, asking ${money(listing.priceCents, listing.currency)}. Reply ACCEPT ${offer.id}, COUNTER ${offer.id} <price>, or DECLINE ${offer.id}.`,
      },
    );
  } else {
    out.push(
      reply(
        ctx,
        `Offer ${offer.id} sent: ${money(offer.proposedPriceCents)} for ${offer.listingId}${title}. This seller is not on the simulated seller phone, so no simulated notification was sent.`,
      ),
    );
  }
  return out;
}

async function handleDetails(ctx: Ctx, listingCode: string): Promise<Outbound[]> {
  const listing = await getListing(listingCode, ctx.db);
  if (!listing) return [reply(ctx, `No listing ${listingCode}.`)];
  const desc = listing.description ? ` ${truncate(listing.description, 200)}` : "";
  return [reply(ctx, `${describeListing(listing)} · ${listing.status}.${desc}`)];
}

async function handleRemove(ctx: Ctx, listingCode: string): Promise<Outbound[]> {
  if (ctx.actor !== "seller") return [reply(ctx, "Only the seller phone can remove a listing.")];
  const listing = await getListing(listingCode, ctx.db);
  if (!listing) return [reply(ctx, `No listing ${listingCode}.`)];
  if (listing.sellerId !== ctx.handset.userId) return [reply(ctx, `${listingCode} isn't your listing.`)];
  if (listing.status === "removed") return [reply(ctx, `${listingCode} was already removed.`)];
  if (listing.status === "sold") return [reply(ctx, `${listingCode} is sold and can't be removed.`)];
  await updateListingStatus(listingCode, "removed", ctx.db);
  return [reply(ctx, `${listingCode} removed.`)];
}

function handleAgent(ctx: Ctx, index: number): Outbound[] {
  const agent = ctx.session.lastSearch?.externalCapabilities[index - 1];
  if (!agent) return [reply(ctx, `No agent #${index} in your last search. Text SEARCH <item> first.`)];
  const desc = agent.description ? ` ${truncate(agent.description, 160)}` : "";
  return [
    reply(ctx, `${agent.name} (${agent.readiness.replaceAll("_", " ")}).${desc} Not PingMarket inventory. ${agent.agentPageUrl}`),
  ];
}

async function handleNegotiation(
  ctx: Ctx,
  intent: Extract<SmsIntent, { type: "counter" | "accept" | "decline" }>,
): Promise<Outbound[]> {
  const { negotiation } = ctx.opts;
  const verb = intent.type.toUpperCase();
  if (!negotiation) {
    const offer = await getOffer(intent.offerCode, ctx.db);
    const state = offer ? ` Offer ${offer.id} stays ${offer.status}.` : ` No offer ${intent.offerCode}.`;
    return [reply(ctx, `${verb} isn't wired in this build yet (negotiation service pending).${state}`)];
  }
  let offer: Offer;
  try {
    const actorId = ctx.handset.userId;
    offer =
      intent.type === "counter"
        ? await negotiation.counter({ offerId: intent.offerCode, actorId, priceCents: intent.priceCents }, ctx.db)
        : intent.type === "accept"
          ? await negotiation.accept({ offerId: intent.offerCode, actorId }, ctx.db)
          : await negotiation.decline({ offerId: intent.offerCode, actorId }, ctx.db);
  } catch (err) {
    if (err instanceof Error) return [reply(ctx, `Couldn't ${verb} ${intent.offerCode}: ${err.message}`)];
    throw err;
  }
  const out: Outbound[] = [reply(ctx, `Offer ${offer.id} is now ${offer.status} at ${money(offer.proposedPriceCents)}.`)];
  const counterpartId = ctx.actor === "seller" ? offer.buyerId : offer.sellerId;
  if (counterpartId === ctx.other.userId) {
    const next =
      offer.status === "countered"
        ? ` Reply ACCEPT ${offer.id} or DECLINE ${offer.id}.`
        : offer.status === "accepted"
          ? " Payment link follows on the dashboard."
          : "";
    out.push({ to: ctx.other.number, body: `Offer ${offer.id} on ${offer.listingId}: ${offer.status} at ${money(offer.proposedPriceCents)}.${next}` });
  }
  return out;
}

async function route(ctx: Ctx, intent: SmsIntent): Promise<Outbound[]> {
  switch (intent.type) {
    case "help":
      return [reply(ctx, HELP[ctx.actor])];
    case "stop":
      ctx.session.draft = undefined;
      return [reply(ctx, "You won't receive more PingMarket texts. (Simulated: nothing is unsubscribed.) Reply HELP to continue.")];
    case "cancel": {
      const had = Boolean(ctx.session.draft);
      ctx.session.draft = undefined;
      ctx.session.draftMarketplaceId = undefined;
      return [reply(ctx, had ? "Listing cancelled." : "Nothing to cancel.")];
    }
    case "sell":
      return handleSell(ctx, intent);
    case "search":
      return handleSearch(ctx, intent.query);
    case "offer":
      return handleOffer(ctx, intent.listingCode, intent.priceCents);
    case "details":
      return handleDetails(ctx, intent.listingCode);
    case "remove":
      return handleRemove(ctx, intent.listingCode);
    case "edit":
      return [reply(ctx, `EDIT isn't supported yet. REMOVE ${intent.listingCode} and SELL again.`)];
    case "agent":
      return handleAgent(ctx, intent.index);
    case "counter":
    case "accept":
    case "decline":
      return handleNegotiation(ctx, intent);
    case "invalid":
      return [reply(ctx, intent.message)];
    case "unrecognized":
      return [reply(ctx, "Sorry, I didn't get that. Reply HELP for commands.")];
  }
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
  const ctx: Ctx = {
    db,
    actor: input.actor,
    handset,
    other,
    marketplaceId: input.marketplaceId ?? "furniture",
    session: session(input.actor, now),
    opts,
  };

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

  const intent = ctx.session.draft ? clarifyListing(ctx.session.draft, input.body) : parseSms(input.body);
  let outbound: Outbound[];
  try {
    outbound = await route(ctx, intent);
  } catch (err) {
    console.error("[sms-sim] router failed", err);
    outbound = [reply(ctx, "Something went wrong on our side. Please try again.")];
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
