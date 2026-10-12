/**
 * Verifies both Keewano connections and prints what the negotiation insight will see.
 *
 *   npm run keewano:check
 */
import { KEEWANO_EVENTS_HASH } from "../src/lib/keewano/catalog";
import { ensureCatalogRegistered } from "../src/lib/keewano/ingest";
import { isKeewanoQueryConfigured, keewanoQuery } from "../src/lib/keewano/query";

async function step(label: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    const result = await run();
    console.log(`✔ ${label}`);
    if (result !== undefined) console.table(result);
    return true;
  } catch (err) {
    console.log(`✘ ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function main() {
  let ok = true;
  const key = process.env.KEEWANO_API_KEY?.trim();
  if (key) {
    ok = (await step(`ingest: custom events registered (hash ${KEEWANO_EVENTS_HASH})`, () => ensureCatalogRegistered(key))) && ok;
  } else {
    console.log("✘ ingest: KEEWANO_API_KEY is not set");
    ok = false;
  }

  if (!isKeewanoQueryConfigured()) {
    console.log("✘ query: set KEEWANO_PAT, KEEWANO_USER_EMAIL and KEEWANO_PROJECT_ID");
    process.exit(1);
  }
  ok =
    (await step("query: project totals", () =>
      keewanoQuery("SELECT count(DISTINCT user_id) AS entities, count(*) AS events FROM events", 30_000),
    )) && ok;
  ok =
    (await step("query: counter history by band (what the advice uses)", () =>
      keewanoQuery(
        `SELECT "Offer Marketplace" AS marketplace, "Counter Band" AS band, count("Offer Accepted") AS accepted, ` +
          `count("Offer Declined") AS declined FROM events WHERE "Counter Band" IS NOT NULL GROUP BY marketplace, band ORDER BY marketplace, band`,
        30_000,
      ),
    )) && ok;
  ok =
    (await step("query: offers in the last 24h by listing", () =>
      keewanoQuery(
        `SELECT "Offer Listing" AS listing, count(DISTINCT user_id) AS offers, max("Offer Made Cents") AS top_cents FROM events ` +
          `WHERE "Offer Listing" IS NOT NULL AND event_datetime >= now() - INTERVAL '24 hours' GROUP BY listing ORDER BY offers DESC LIMIT 10`,
        30_000,
      ),
    )) && ok;
  process.exit(ok ? 0 : 1);
}

void main();
