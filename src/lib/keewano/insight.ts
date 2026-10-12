/**
 * Demand-aware negotiation: before a seller answers an offer, ask Keewano
 *   1. how many other offers this listing drew in the last 24h, and the best of them,
 *   2. how many times it was viewed in the last 24h,
 *   3. at which counter price (as a share of the ask) buyers in this marketplace actually accepted,
 * and turn the answers into one recommendation: ACCEPT, or COUNTER at a price.
 *
 * The recommendation is texted to the seller with the new-offer SMS and shown in the dashboard's seller
 * console; each recommendation is recorded back into Keewano (`Negotiation Advice`) so its effect on
 * closed deals can be measured there.
 */
import { money } from "../sms/text";
import type { Listing, Offer } from "../types";
import { bandLowerBound, listingKey, offerKey, pctOfAsk } from "./catalog";
import { track } from "./ingest";
import { isKeewanoQueryConfigured, keewanoQuery, lit, num } from "./query";

export interface CounterBandStat {
  /** Counter price as a share of the ask, e.g. `90-99`. */
  band: string;
  accepted: number;
  declined: number;
}

export interface NegotiationAdvice {
  action: "accept" | "counter";
  /** Accept: the offer's price. Counter: the suggested price, whole dollars, never above the ask. */
  priceCents: number;
  /** What drove the price: marketplace counter history, live demand on the listing, or neither. */
  basis: "history" | "demand" | "no_history";
  reasons: string[];
}

export interface NegotiationInsight {
  offerId: string;
  listingId: string;
  askCents: number;
  offerCents: number;
  offerPct: number;
  currency: string;
  /** Null when that Keewano query failed (see `errors`). */
  otherOffers24h: number | null;
  topOtherOfferCents: number | null;
  views24h: number | null;
  counterBands: CounterBandStat[];
  advice: NegotiationAdvice;
  queriedAt: string;
  errors: string[];
}

const MIN_SAMPLE = 3;
const MIN_ACCEPT_RATE = 0.5;
const CACHE_TTL_MS = 60_000;

function wholeDollars(cents: number): number {
  return Math.max(100, Math.round(cents / 100) * 100);
}

/** Pure: Keewano answers in, one recommendation out. */
export function adviseNegotiation(input: {
  askCents: number;
  offerCents: number;
  currency?: string;
  otherOffers24h: number | null;
  topOtherOfferCents: number | null;
  counterBands: CounterBandStat[];
}): NegotiationAdvice {
  const { askCents, offerCents, currency = "USD" } = input;
  const reasons: string[] = [];
  let basis: NegotiationAdvice["basis"] = "no_history";
  let targetPct: number | null = null;

  // Highest counter band buyers still accepted at least half the time, with enough history to trust.
  const reliable = input.counterBands.filter((b) => {
    const total = b.accepted + b.declined;
    return total >= MIN_SAMPLE && b.accepted / total >= MIN_ACCEPT_RATE;
  });
  if (reliable.length > 0) {
    const best = reliable.reduce((a, b) => (bandLowerBound(b.band) > bandLowerBound(a.band) ? b : a));
    targetPct = best.band === "100+" ? 100 : bandLowerBound(best.band) + 5;
    basis = "history";
    reasons.push(`buyers accepted ${best.accepted}/${best.accepted + best.declined} counters at ${best.band}% of ask`);
  }

  const others = input.otherOffers24h ?? 0;
  if (others >= 2) {
    targetPct = Math.min(100, (targetPct ?? 90) + 5);
    if (basis === "no_history") basis = "demand";
    reasons.push(`${others} other offers in 24h`);
  }

  let targetCents = targetPct === null ? (offerCents + askCents) / 2 : (askCents * targetPct) / 100;
  if (targetPct === null) reasons.push("no counter history yet, splitting the difference");
  if (input.topOtherOfferCents && input.topOtherOfferCents > targetCents) {
    targetCents = input.topOtherOfferCents;
    if (basis === "no_history") basis = "demand";
    reasons.push(`another buyer offered ${money(input.topOtherOfferCents, currency)}`);
  }
  targetCents = Math.min(askCents, targetCents);

  const counterCents = Math.min(askCents, wholeDollars(targetCents));
  if (offerCents >= targetCents || counterCents <= offerCents) {
    return { action: "accept", priceCents: offerCents, basis, reasons: [`offer is ${pctOfAsk(offerCents, askCents)}% of ask`, ...reasons] };
  }
  return { action: "counter", priceCents: counterCents, basis, reasons };
}

const cache = new Map<string, { at: number; insight: NegotiationInsight }>();
const recorded = new Set<string>();

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Runs the live Keewano queries for an offer awaiting the seller. Null when Keewano querying is not
 * configured. Individual query failures degrade the insight (listed in `errors`), never throw.
 */
export async function getNegotiationInsight(offer: Offer, listing: Listing): Promise<NegotiationInsight | null> {
  if (!isKeewanoQueryConfigured()) return null;
  const cacheKey = `${offer.id}@${offer.updatedAt}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.insight;

  const lk = lit(listingKey(listing));
  const [demand, views, bands] = await Promise.allSettled([
    keewanoQuery(
      `SELECT count(DISTINCT user_id) AS offers, max("Offer Made Cents") AS top_cents FROM events ` +
        `WHERE "Offer Listing Key" = ${lk} AND NOT ("Offer Key" = ${lit(offerKey(offer))}) ` +
        `AND event_datetime >= now() - INTERVAL '24 hours'`,
    ),
    keewanoQuery(
      `SELECT count("Listing Viewed") AS views FROM events ` +
        `WHERE "Listing Key" = ${lk} AND event_datetime >= now() - INTERVAL '24 hours'`,
    ),
    keewanoQuery(
      `SELECT "Counter Band" AS band, count("Offer Accepted") AS accepted, count("Offer Declined") AS declined ` +
        `FROM events WHERE "Counter Band" IS NOT NULL AND "Offer Marketplace" = ${lit(listing.marketplaceId)} ` +
        `GROUP BY band`,
    ),
  ]);

  const errors: string[] = [];
  let otherOffers24h: number | null = null;
  let topOtherOfferCents: number | null = null;
  if (demand.status === "fulfilled") {
    otherOffers24h = num(demand.value[0]?.offers) ?? 0;
    topOtherOfferCents = otherOffers24h > 0 ? num(demand.value[0]?.top_cents) : null;
  } else errors.push(`demand: ${errorText(demand.reason)}`);
  let views24h: number | null = null;
  if (views.status === "fulfilled") views24h = num(views.value[0]?.views) ?? 0;
  else errors.push(`views: ${errorText(views.reason)}`);
  let counterBands: CounterBandStat[] = [];
  if (bands.status === "fulfilled") {
    counterBands = bands.value
      .filter((r) => typeof r.band === "string")
      .map((r) => ({ band: r.band as string, accepted: num(r.accepted) ?? 0, declined: num(r.declined) ?? 0 }))
      .sort((a, b) => bandLowerBound(a.band) - bandLowerBound(b.band));
  } else errors.push(`counter history: ${errorText(bands.reason)}`);
  if (errors.length > 0) console.warn(`[keewano] insight for ${offer.id}: ${errors.join("; ")}`);

  const advice = adviseNegotiation({
    askCents: listing.priceCents,
    offerCents: offer.proposedPriceCents,
    currency: listing.currency,
    otherOffers24h,
    topOtherOfferCents,
    counterBands,
  });
  const insight: NegotiationInsight = {
    offerId: offer.id,
    listingId: listing.id,
    askCents: listing.priceCents,
    offerCents: offer.proposedPriceCents,
    offerPct: pctOfAsk(offer.proposedPriceCents, listing.priceCents),
    currency: listing.currency,
    otherOffers24h,
    topOtherOfferCents,
    views24h,
    counterBands,
    advice,
    queriedAt: new Date().toISOString(),
    errors,
  };
  cache.set(cacheKey, { at: Date.now(), insight });

  // Close the loop: record what we advised, once per distinct recommendation.
  const adviceKey = `${offerKey(offer)}:${advice.action}:${advice.priceCents}`;
  if (!recorded.has(adviceKey)) {
    recorded.add(adviceKey);
    track("offer", offerKey(offer), [
      { name: "Negotiation Advice", value: advice.action },
      { name: "Advice Price Cents", value: advice.priceCents },
    ]);
  }
  return insight;
}

/** One line appended to the seller's new-offer text, e.g. `Tip: 2 other offers in 24h. Try COUNTER O7 108`. */
export function insightSmsLine(insight: NegotiationInsight): string {
  const { advice } = insight;
  const why = advice.reasons.slice(0, 2).join("; ");
  const action =
    advice.action === "accept"
      ? `Try ACCEPT ${insight.offerId}`
      : `Try COUNTER ${insight.offerId} ${Math.round(advice.priceCents / 100)}`;
  return `Tip: ${why}. ${action}.`;
}

/** Same as `getNegotiationInsight`, but never throws and gives up after `timeoutMs` (SMS path). */
export async function tryNegotiationInsight(offer: Offer, listing: Listing, timeoutMs = 5000): Promise<NegotiationInsight | null> {
  try {
    return await Promise.race([
      getNegotiationInsight(offer, listing),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs).unref?.()),
    ]);
  } catch (err) {
    console.warn(`[keewano] insight for ${offer.id} failed: ${errorText(err)}`);
    return null;
  }
}
