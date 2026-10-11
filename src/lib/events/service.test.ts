import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db";
import { messages } from "../db/schema";
import { createTestDb } from "../db/testing";
import { createOffer } from "../offers/service";
import { runSearch } from "../search/service";
import { formatMoney, listTraceEvents, maskPhone } from "./service";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  await db.insert(messages).values({
    id: "msg_1",
    dialEventId: "evt_1",
    fromNumber: "+15550000002",
    toNumber: "+15550000001",
    body: "SELL oak desk, $120, Berkeley. Pickup only.",
    direction: "inbound",
  });
  await createOffer({ listingId: "D1", priceCents: 10000 }, db);
  await runSearch({ query: "poster", includeExternalAgents: false }, { db });
});

describe("listTraceEvents", () => {
  it("formats helpers", () => {
    expect(maskPhone("+1 (555) 000-0002")).toBe("…0002");
    expect(formatMoney(120000)).toBe("$1,200.00");
  });

  it("unions messages, listings, searches and offers newest first", async () => {
    const events = await listTraceEvents(50, db);
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds).toEqual(new Set(["sms_inbound", "listing_created", "offer", "search"]));
    const ats = events.map((e) => e.at);
    expect(ats).toEqual([...ats].sort().reverse());

    const sms = events.find((e) => e.kind === "sms_inbound");
    expect(sms?.summary).toBe("…0002 → …0001: SELL oak desk, $120, Berkeley. Pickup only.");
    expect(sms?.summary).not.toContain("5550000002");
    expect(events.find((e) => e.id === "listing:D1")?.summary).toBe(
      "Listing D1 created: Oak desk — $120.00 (Furniture Market)",
    );
    expect(events.find((e) => e.kind === "offer")?.summary).toMatch(
      /^Offer O\d+: \$100\.00 for D1 — open \(web_simulated\)$/,
    );
    expect(events.find((e) => e.kind === "search")?.summary).toMatch(
      /^Search "poster" → Darwin skipped, \d+ native$/,
    );
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it("respects the limit", async () => {
    expect(await listTraceEvents(3, db)).toHaveLength(3);
  });
});
