/**
 * Shared SMS command router for every phone that texts PingMarket: the /sim demo handsets
 * (`./simulator.ts`) and the real buyer phone over Dial (`./inbound.ts`).
 *
 * Each text is parsed with Developer A's `parseSms` grammar and routed into the real listings /
 * search / offers / negotiation services. The router only returns replies; callers store and send them.
 * Identity (`actor`) is trusted server context resolved from the phone number, never from the text.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { users } from "../db/schema";
import { createListing, getListing, ListingError, updateListingStatus } from "../listings/service";
import { dbNegotiation, NegotiationError, type NegotiationOutcome } from "../negotiation/db-service";
import { createOffer, OfferError } from "../offers/service";
import { getOrCreateOrderForOffer } from "../orders/service";
import { runSearch, type RunSearchOptions } from "../search/service";
import type { Listing, MarketplaceId, Offer, OfferSource, SearchResponse } from "../types";
import { clarifyListing, parseSms, type SmsIntent } from "./intent";
import {
  acceptedText,
  buyerAcceptedText,
  buyerDeclinedText,
  checkoutLinkForOrder,
  counterText,
  declinedText,
  fitSms,
  MAX_SMS_CHARS,
  money,
  newOfferText,
  notifyNewOffer,
  notifyTransition,
  sellerMovedText,
  truncate,
} from "./notify";
import { describeError } from "./outbound";
import type { ListingDraft } from "./ports";

export { MAX_SMS_CHARS };

/**
 * Negotiation backend. Returning a bare `Offer` (e.g. a test double) is treated as
 * `{ offer, changed: true, declined: [] }`.
 */
export interface NegotiationPort {
  counter(input: { offerId: string; actorId: string; priceCents: number }, db: Db): Promise<Offer | NegotiationOutcome>;
  accept(input: { offerId: string; actorId: string }, db: Db): Promise<Offer | NegotiationOutcome>;
  decline(input: { offerId: string; actorId: string }, db: Db): Promise<Offer | NegotiationOutcome>;
}

export interface SmsActor {
  userId: string;
  number: string;
  role: "buyer" | "seller";
  /** Offer source for offers this phone creates. */
  source: OfferSource;
  /** `sim`: a /sim demo handset (fake numbers). `dial`: a real phone texting the Dial service number. */
  channel: "sim" | "dial";
}

/** The other /sim handset, texted directly when an offer involves it. */
export interface SmsCounterpart {
  userId: string;
  number: string;
}

/** Per-phone conversation state (listing draft, last search). */
export interface SmsSession {
  draft?: ListingDraft;
  draftMarketplaceId?: MarketplaceId;
  lastSearch?: SearchResponse;
  touchedAt: number;
}

export interface SmsRouterOptions {
  search?: Omit<RunSearchOptions, "db">;
  /** Defaults to the drizzle negotiation service (`dbNegotiation`). */
  negotiation?: NegotiationPort;
}

export interface OutboundSms {
  to: string;
  body: string;
}

export interface RouteSmsInput {
  db: Db;
  actor: SmsActor;
  counterpart?: SmsCounterpart;
  marketplaceId: MarketplaceId;
  session: SmsSession;
  body: string;
  opts?: SmsRouterOptions;
}

const SESSION_TTL_MS = 10 * 60 * 1000;

/** In-memory per-phone sessions keyed by phone number; expire after 10 minutes idle. */
export function createSessionStore() {
  const sessions = new Map<string, SmsSession>();
  return {
    get(key: string, now: number): SmsSession {
      const existing = sessions.get(key);
      if (existing && now - existing.touchedAt <= SESSION_TTL_MS) {
        existing.touchedAt = now;
        return existing;
      }
      const fresh: SmsSession = { touchedAt: now };
      sessions.set(key, fresh);
      return fresh;
    },
    clear(): void {
      sessions.clear();
    },
  };
}
export type SmsSessionStore = ReturnType<typeof createSessionStore>;

// ---------------------------------------------------------------------------

interface Ctx extends RouteSmsInput {
  opts: SmsRouterOptions;
}

function reply(ctx: Ctx, body: string): OutboundSms {
  return { to: ctx.actor.number, body };
}

const isSim = (ctx: Ctx) => ctx.actor.channel === "sim";

const HELP: Record<SmsActor["role"], string> = {
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
    "DETAILS D2 · OFFER D2 80",
    "ACCEPT O7 · DECLINE O7 · AGENT 1",
    "HELP · STOP",
  ].join("\n"),
};

const DRAFT_PROMPT: Record<"title" | "priceCents" | "location", string> = {
  title: "What are you selling?",
  priceCents: "What price? e.g. $120",
  location: "Where is it? e.g. Berkeley",
};

function describeListing(l: Listing): string {
  const where = l.location ? ` · ${l.location}` : "";
  return `${l.id} ${truncate(l.title, 60)} — ${money(l.priceCents, l.currency)}${where}`;
}

function notBuyer(ctx: Ctx): OutboundSms {
  return reply(
    ctx,
    isSim(ctx)
      ? "This phone is the seller handset. Switch to the buyer phone to make an offer."
      : "This number is registered as a seller. Make offers from a buyer phone.",
  );
}

async function handleSell(ctx: Ctx, intent: Extract<SmsIntent, { type: "sell" }>): Promise<OutboundSms[]> {
  if (ctx.actor.role !== "seller") {
    return [
      reply(
        ctx,
        isSim(ctx)
          ? "This phone is the buyer handset. Switch to the seller phone to text SELL."
          : "This number is registered as a buyer, so it can't list items. Text SEARCH <item> to shop, or HELP for commands.",
      ),
    ];
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
        sellerId: ctx.actor.userId,
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

async function handleSearch(ctx: Ctx, query: string): Promise<OutboundSms[]> {
  const resp = await runSearch({ query, marketplaceId: ctx.marketplaceId }, { ...ctx.opts.search, db: ctx.db });
  ctx.session.lastSearch = resp;
  const q = truncate(query, 40);
  const lines: string[] = [];
  const native = resp.nativeListings.slice(0, 3);
  if (native.length === 0) {
    lines.push(`No PingMarket listings matched "${q}".`);
  } else {
    lines.push(`${resp.nativeListings.length} listing${resp.nativeListings.length === 1 ? "" : "s"} for "${q}":`);
    native.forEach((l, i) => {
      const where = l.location ? ` · ${truncate(l.location, 24)}` : "";
      lines.push(`${i + 1}) ${l.id} ${truncate(l.title, 40)} — ${money(l.priceCents, l.currency)}${where}`);
    });
    lines.push(`Reply OFFER ${native[0].id} ${Math.max(1, Math.round((native[0].priceCents * 0.8) / 100))} to make an offer.`);
  }
  const { darwin } = resp;
  const total = resp.externalCapabilities.length;
  const agents = resp.externalCapabilities.slice(0, 3);
  if (agents.length) {
    const plural = total === 1 ? "" : "s";
    const full = `Also ${total} external agent${plural} via Darwin: ${agents
      .map((a, i) => `${i + 1}) ${truncate(a.name, 30)}`)
      .join(" ")}. Reply AGENT 1 for details.`;
    const short = `Also ${total} external agent${plural} via Darwin. Reply AGENT 1 for details.`;
    lines.push([...lines, full].join("\n").length <= MAX_SMS_CHARS ? full : short);
  } else if (darwin.status === "needs_input" && darwin.question) {
    lines.push(`Darwin asks: ${truncate(darwin.question, 160)}`);
  } else if (darwin.status === "error") {
    lines.push("External agent search is unavailable right now.");
  } else if (darwin.status === "no_match") {
    lines.push("No external agents matched.");
  }
  return [reply(ctx, truncate(lines.join("\n"), MAX_SMS_CHARS))];
}

async function handleOffer(ctx: Ctx, listingCode: string, priceCents: number): Promise<OutboundSms[]> {
  if (ctx.actor.role !== "buyer") return [notBuyer(ctx)];
  let offer: Offer;
  try {
    offer = await createOffer({ listingId: listingCode, priceCents, buyerId: ctx.actor.userId, source: ctx.actor.source }, ctx.db);
  } catch (err) {
    if (err instanceof OfferError) {
      const text: Record<OfferError["code"], string> = {
        LISTING_NOT_FOUND: `No listing ${listingCode}. Reply SEARCH <item> to find one.`,
        LISTING_UNAVAILABLE: `${listingCode} is no longer available.`,
        INVALID_PRICE: "Use a positive price, e.g. OFFER D2 80.",
        BUYER_NOT_FOUND: isSim(ctx) ? "This buyer account is missing. Reseed the database." : "Your buyer account is missing. Contact PingMarket.",
        SELF_OFFER: "You can't make an offer on your own listing.",
      };
      return [reply(ctx, text[err.code])];
    }
    throw err;
  }
  const listing = await getListing(offer.listingId, ctx.db);
  const title = listing ? ` (${truncate(listing.title, 60)}, asking ${money(listing.priceCents, listing.currency)})` : "";
  const sent = `Offer ${offer.id} sent: ${money(offer.proposedPriceCents)} for ${offer.listingId}${title}.`;
  if (listing && ctx.counterpart && listing.sellerId === ctx.counterpart.userId) {
    return [
      reply(ctx, `${sent} We'll text you when the seller replies.`),
      { to: ctx.counterpart.number, body: newOfferText(offer, listing) },
    ];
  }
  if (isSim(ctx)) {
    return [reply(ctx, `${sent} This seller is not on the simulated seller phone, so no simulated notification was sent.`)];
  }
  // A real phone made the offer: the /sim seller handset still hears about offers on its listings.
  try {
    await notifyNewOffer(offer, ctx.db);
  } catch (err) {
    console.error(`[sms] new-offer notification for ${offer.id} failed: ${describeError(err)}`);
  }
  return [reply(ctx, `${sent} The seller reviews offers on PingMarket; we'll text you when they respond.`)];
}

async function handleDetails(ctx: Ctx, listingCode: string): Promise<OutboundSms[]> {
  const listing = await getListing(listingCode, ctx.db);
  if (!listing) return [reply(ctx, `No listing ${listingCode}.`)];
  const desc = listing.description ? ` ${truncate(listing.description, 200)}` : "";
  return [reply(ctx, `${describeListing(listing)} · ${listing.status}.${desc}`)];
}

async function handleRemove(ctx: Ctx, listingCode: string): Promise<OutboundSms[]> {
  if (ctx.actor.role !== "seller") {
    return [reply(ctx, isSim(ctx) ? "Only the seller phone can remove a listing." : "Only sellers can remove listings.")];
  }
  const listing = await getListing(listingCode, ctx.db);
  if (!listing) return [reply(ctx, `No listing ${listingCode}.`)];
  if (listing.sellerId !== ctx.actor.userId) return [reply(ctx, `${listingCode} isn't your listing.`)];
  if (listing.status === "removed") return [reply(ctx, `${listingCode} was already removed.`)];
  if (listing.status === "sold") return [reply(ctx, `${listingCode} is sold and can't be removed.`)];
  await updateListingStatus(listingCode, "removed", ctx.db);
  return [reply(ctx, `${listingCode} removed.`)];
}

function handleAgent(ctx: Ctx, index: number): OutboundSms[] {
  const agent = ctx.session.lastSearch?.externalCapabilities[index - 1];
  if (!agent) return [reply(ctx, `No agent #${index} in your last search. Text SEARCH <item> first.`)];
  const desc = agent.description ? ` ${truncate(agent.description, 160)}` : "";
  return [
    reply(
      ctx,
      `${truncate(agent.name, 60)} (${agent.readiness.replaceAll("_", " ")}).${desc} Not PingMarket inventory. ${agent.agentPageUrl}`,
    ),
  ];
}

async function handleNegotiation(
  ctx: Ctx,
  intent: Extract<SmsIntent, { type: "counter" | "accept" | "decline" }>,
): Promise<OutboundSms[]> {
  const negotiation = ctx.opts.negotiation ?? dbNegotiation;
  const verb = intent.type.toUpperCase();
  const actorId = ctx.actor.userId;
  let outcome: NegotiationOutcome;
  try {
    const result =
      intent.type === "counter"
        ? await negotiation.counter({ offerId: intent.offerCode, actorId, priceCents: intent.priceCents }, ctx.db)
        : intent.type === "accept"
          ? await negotiation.accept({ offerId: intent.offerCode, actorId }, ctx.db)
          : await negotiation.decline({ offerId: intent.offerCode, actorId }, ctx.db);
    outcome = "offer" in result ? result : { offer: result, changed: true, declined: [] };
  } catch (err) {
    if (err instanceof NegotiationError) return [reply(ctx, fitSms(`Couldn't ${verb} ${intent.offerCode}: ${err.message}`))];
    throw err;
  }
  const { offer, changed, declined } = outcome;
  const counterpartId = actorId === offer.sellerId ? offer.buyerId : offer.sellerId;
  // The other /sim handset is texted in this reply batch; any other phone through `notifyTransition`.
  const simCounterpart = changed && ctx.counterpart?.userId === counterpartId ? ctx.counterpart : undefined;

  let orderId: string | undefined;
  let checkoutUrl: string | null = null;
  if (offer.status === "accepted") {
    orderId = (await getOrCreateOrderForOffer(offer.id, ctx.db)).order.id;
    if (actorId === offer.buyerId || simCounterpart) checkoutUrl = await checkoutLinkForOrder(orderId, ctx.db);
  }

  const out: OutboundSms[] = [];
  if (actorId === offer.sellerId) {
    out.push(reply(ctx, sellerMovedText(offer, orderId)));
  } else if (offer.status === "accepted") {
    out.push(reply(ctx, acceptedText(offer, orderId!, checkoutUrl)));
  } else {
    out.push(reply(ctx, `Offer ${offer.id} is now ${offer.status} at ${money(offer.proposedPriceCents)}.`));
  }
  if (!changed) return out; // idempotent repeat: nobody else is told again

  if (simCounterpart) {
    const body = await counterpartText(ctx, offer, actorId, orderId, checkoutUrl);
    if (body) out.push({ to: simCounterpart.number, body });
  }
  // Competing offers this accept declined: the other /sim handset's arrive after the accept, in this batch.
  const simBuyer = ctx.counterpart;
  const declinedHere = simBuyer ? declined.filter((o) => o.buyerId === simBuyer.userId) : [];
  for (const other of declinedHere) out.push({ to: simBuyer!.number, body: declinedText(other) });
  await notifyTransition(
    { offer, actorId, declined: declined.filter((o) => !declinedHere.includes(o)), orderId, counterpart: !simCounterpart },
    ctx.db,
  );
  return out;
}

/** What the other /sim handset sees after `actorId` moved `offer` (same wording as a real phone). */
async function counterpartText(
  ctx: Ctx,
  offer: Offer,
  actorId: string,
  orderId: string | undefined,
  checkoutUrl: string | null,
): Promise<string | null> {
  if (actorId === offer.sellerId) {
    if (offer.status === "countered") return counterText(offer, (await getListing(offer.listingId, ctx.db))?.title ?? null);
    if (offer.status === "accepted") return acceptedText(offer, orderId!, checkoutUrl);
    if (offer.status === "declined") return declinedText(offer);
    return null;
  }
  if (offer.status === "accepted") return buyerAcceptedText(offer, orderId!);
  if (offer.status === "declined") return buyerDeclinedText(offer);
  return null;
}

async function handleStop(ctx: Ctx): Promise<OutboundSms[]> {
  ctx.session.draft = undefined;
  ctx.session.draftMarketplaceId = undefined;
  if (isSim(ctx)) {
    return [reply(ctx, "You won't receive more PingMarket texts. (Simulated: nothing is unsubscribed.) Reply HELP to continue.")];
  }
  await ctx.db.update(users).set({ consentStatus: "opted_out" }).where(eq(users.id, ctx.actor.userId));
  return [reply(ctx, "You're unsubscribed from PingMarket offer updates. Text HELP or any command to start again.")];
}

async function route(ctx: Ctx, intent: SmsIntent): Promise<OutboundSms[]> {
  switch (intent.type) {
    case "help":
      return [reply(ctx, HELP[ctx.actor.role])];
    case "stop":
      return handleStop(ctx);
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
      return [
        reply(
          ctx,
          ctx.actor.role === "seller"
            ? `EDIT isn't supported yet. REMOVE ${intent.listingCode} and SELL again.`
            : "Only sellers can edit listings.",
        ),
      ];
    case "agent":
      return handleAgent(ctx, intent.index);
    case "counter":
      if (ctx.actor.role !== "seller") return [reply(ctx, `Only the seller can counter. Reply ACCEPT ${intent.offerCode} or DECLINE ${intent.offerCode}.`)];
      return handleNegotiation(ctx, intent);
    case "accept":
    case "decline":
      return handleNegotiation(ctx, intent);
    case "invalid":
      return [reply(ctx, intent.message)];
    case "unrecognized":
      return [reply(ctx, "Sorry, I didn't get that. Reply HELP for commands.")];
  }
}

/** Routes one inbound text. Throws on unexpected (non-domain) errors; callers send a generic apology. */
export async function routeSms(input: RouteSmsInput): Promise<{ replies: OutboundSms[] }> {
  const ctx: Ctx = { ...input, opts: input.opts ?? {} };
  const intent = ctx.session.draft ? clarifyListing(ctx.session.draft, input.body) : parseSms(input.body);
  return { replies: await route(ctx, intent) };
}
