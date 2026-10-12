import { connection, NextResponse } from "next/server";
import { isKeewanoIngestEnabled } from "@/lib/keewano/ingest";
import { isKeewanoQueryConfigured, keewanoQuery, num } from "@/lib/keewano/query";

export interface LiveKeewanoResponse {
  ingestionConfigured: boolean;
  queryConfigured: boolean;
  status: "not_configured" | "connected" | "error";
  entities: number | null;
  events: number | null;
  counterBands: Array<{ marketplace: string; band: string; accepted: number; declined: number }>;
  queriedAt: string | null;
  error?: string;
}

/** Live read-only project statistics, using the same queries as keewano:check. */
export async function GET() {
  await connection();
  const response: LiveKeewanoResponse = {
    ingestionConfigured: isKeewanoIngestEnabled(),
    queryConfigured: isKeewanoQueryConfigured(),
    status: "not_configured",
    entities: null,
    events: null,
    counterBands: [],
    queriedAt: null,
  };
  if (response.queryConfigured) {
    try {
      const [totals, bands] = await Promise.all([
        keewanoQuery("SELECT count(DISTINCT user_id) AS entities, count(*) AS events FROM events"),
        keewanoQuery(
          `SELECT "Offer Marketplace" AS marketplace, "Counter Band" AS band, count("Offer Accepted") AS accepted, ` +
            `count("Offer Declined") AS declined FROM events WHERE "Counter Band" IS NOT NULL GROUP BY marketplace, band ORDER BY marketplace, band`,
        ),
      ]);
      response.status = "connected";
      response.entities = num(totals[0]?.entities);
      response.events = num(totals[0]?.events);
      response.counterBands = bands.map((row) => ({
        marketplace: String(row.marketplace ?? ""),
        band: String(row.band ?? ""),
        accepted: num(row.accepted) ?? 0,
        declined: num(row.declined) ?? 0,
      }));
      response.queriedAt = new Date().toISOString();
    } catch {
      response.status = "error";
      response.error = "Keewano is unavailable. Try refreshing in a moment.";
    }
  }
  return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
}
