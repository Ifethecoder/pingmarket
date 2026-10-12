/**
 * Seeds Keewano with two weeks of SYNTHETIC negotiation history so the counter-history half of the
 * negotiation insight has data from the first demo minute (live events take ~5 minutes to be queryable).
 *
 *   npm run keewano:backfill -- [--offers 240] [--days 14]
 *
 * Every synthetic offer has `Offer Source = "backfill"` and listing ids `BF…`, so it can be excluded in any
 * query (`WHERE NOT ("Offer Source" = 'backfill')`). Needs KEEWANO_API_KEY.
 */
import { randomUUID } from "node:crypto";
import { pctBand, type KeewanoEvent } from "../src/lib/keewano/catalog";
import { entityUuid, sendEvents } from "../src/lib/keewano/ingest";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const OFFERS = arg("offers", 240);
const DAYS = arg("days", 14);
const MARKETPLACES = [
  { id: "furniture", asks: [4500, 8000, 12000, 18000, 25000, 40000] },
  { id: "creative", asks: [3000, 6000, 9000, 15000, 22000] },
];

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; // roughly N(0, 0.5)

/** Buyers get pickier the closer a counter is to the ask. */
function buyerAcceptsCounter(counterPct: number): boolean {
  const p = counterPct >= 100 ? 0.25 : counterPct >= 95 ? 0.4 : counterPct >= 90 ? 0.62 : counterPct >= 85 ? 0.78 : 0.88;
  return Math.random() < p;
}

function simulateOffer(n: number, startSec: number): { key: string; events: KeewanoEvent[] } {
  const market = pick(MARKETPLACES);
  const ask = pick(market.asks);
  const listingId = `BF${(n % 40) + 1}`;
  const key = `backfill-${randomUUID()}`;
  const offerPct = clamp(Math.round(80 + gauss() * 20), 40, 100);
  const offerCents = Math.round((ask * offerPct) / 100 / 100) * 100;
  let t = startSec;
  const at = (dt: number) => (t += dt);
  const events: KeewanoEvent[] = [
    { name: "Offer Key", value: key, timestamp: t },
    { name: "Offer Listing", value: listingId, timestamp: t },
    { name: "Offer Listing Key", value: `${listingId}:backfill`, timestamp: t },
    { name: "Offer Marketplace", value: market.id, timestamp: t },
    { name: "Offer Source", value: "backfill", timestamp: t },
    { name: "Offer Ask Cents", value: ask, timestamp: t },
    { name: "Offer Pct Of Ask", value: offerPct, timestamp: t },
    { name: "Offer Band", value: pctBand(offerPct), timestamp: t },
    { name: "Offer Made Cents", value: offerCents, timestamp: t },
  ];

  const roll = Math.random();
  if (offerPct >= 92 && roll < 0.75) {
    events.push({ name: "Offer Accepted", value: "seller", timestamp: at(600 + Math.random() * 7200) });
  } else if (roll < 0.15) {
    events.push({ name: "Offer Declined", value: "seller", timestamp: at(600 + Math.random() * 7200) });
  } else {
    const counterPct = clamp(offerPct + 5 + Math.round(Math.random() * 15), offerPct + 1, 100);
    const counterCents = Math.round((ask * counterPct) / 100 / 100) * 100;
    events.push(
      { name: "Counter Band", value: pctBand(counterPct), timestamp: at(600 + Math.random() * 7200) },
      { name: "Counter Cents", value: counterCents, timestamp: t },
    );
    events.push(
      buyerAcceptsCounter(counterPct)
        ? { name: "Offer Accepted", value: "buyer", timestamp: at(300 + Math.random() * 3600) }
        : { name: "Offer Declined", value: "buyer", timestamp: at(300 + Math.random() * 3600) },
    );
  }
  const accepted = events.at(-1)?.name === "Offer Accepted";
  if (accepted && Math.random() < 0.85) {
    const price = events.findLast((e) => e.name === "Counter Cents")?.value ?? offerCents;
    events.push({ name: "Order Paid Cents", value: price, timestamp: at(120 + Math.random() * 1800) });
  }
  return { key, events };
}

async function main() {
  if (!process.env.KEEWANO_API_KEY?.trim()) {
    console.error("KEEWANO_API_KEY is not set (Settings → Project → API Keys). Add it to .env.local.");
    process.exit(1);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  // Keep backfilled history older than 1 day so it never counts as live demand on a listing.
  const span = (DAYS - 1) * 86400;
  const jobs = Array.from({ length: OFFERS }, (_, n) => simulateOffer(n, nowSec - 86400 - Math.floor(Math.random() * span)));

  let sent = 0;
  let accepted = 0;
  let failed = 0;
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try {
          accepted += await sendEvents(entityUuid("offer", job.key), job.events);
          sent++;
        } catch (err) {
          failed++;
          if (failed <= 3) console.error(err instanceof Error ? err.message : err);
        }
      }
    }),
  );
  console.log(`Backfilled ${sent}/${OFFERS} synthetic offers over ${DAYS} days (${accepted} events accepted, ${failed} failed).`);
  console.log("Give Keewano ~5 minutes, then run: npm run keewano:check");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
