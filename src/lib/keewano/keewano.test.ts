import { describe, expect, it } from "vitest";
import { bandLowerBound, KEEWANO_EVENT_TYPES, KEEWANO_EVENTS_HASH, listingKey, pctBand, pctOfAsk } from "./catalog";
import { entityUuid, isKeewanoIngestEnabled, uuidV5 } from "./ingest";
import { adviseNegotiation, insightSmsLine, type NegotiationInsight } from "./insight";
import { lit } from "./query";

describe("catalog", () => {
  it("has unique custom ids >= 2000 and a non-zero hash", () => {
    const ids = KEEWANO_EVENT_TYPES.map((e) => e.eventTypeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.min(...ids)).toBeGreaterThanOrEqual(2000);
    expect(KEEWANO_EVENTS_HASH).toBeGreaterThan(0);
  });

  it("bands prices by share of ask", () => {
    expect(pctOfAsk(9000, 10000)).toBe(90);
    expect(pctBand(90)).toBe("90-99");
    expect(pctBand(49)).toBe("<50");
    expect(pctBand(105)).toBe("100+");
    expect(bandLowerBound("80-89")).toBe(80);
    expect(bandLowerBound("<50")).toBe(0);
  });

  it("keys listings by id and creation second", () => {
    expect(listingKey({ id: "D2", createdAt: "2026-10-11T00:00:01.500Z" })).toBe("D2:1791676801");
  });
});

describe("ingest", () => {
  it("derives RFC 4122 v5 UUIDs", () => {
    // Python: uuid.uuid5(uuid.NAMESPACE_URL, "machine-7")
    expect(uuidV5("machine-7")).toBe("5ae0c507-e5da-5afe-ae97-1fc44e5c9303");
    expect(uuidV5("machine-7")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(entityUuid("offer", "O1:1")).toBe(entityUuid("offer", "O1:1"));
    expect(entityUuid("offer", "O1:1")).not.toBe(entityUuid("listing", "O1:1"));
  });

  it("is disabled under vitest even with a key", () => {
    expect(isKeewanoIngestEnabled()).toBe(false);
  });
});

describe("adviseNegotiation", () => {
  const base = { askCents: 20000, otherOffers24h: 0, topOtherOfferCents: null, counterBands: [] };

  it("counters at the highest band buyers reliably accept", () => {
    const advice = adviseNegotiation({
      ...base,
      offerCents: 15000,
      counterBands: [
        { band: "80-89", accepted: 8, declined: 2 },
        { band: "90-99", accepted: 5, declined: 3 },
        { band: "100+", accepted: 1, declined: 4 },
      ],
    });
    expect(advice).toMatchObject({ action: "counter", priceCents: 19000, basis: "history" });
    expect(advice.reasons[0]).toContain("5/8 counters at 90-99%");
  });

  it("ignores bands with too little history", () => {
    const advice = adviseNegotiation({ ...base, offerCents: 15000, counterBands: [{ band: "100+", accepted: 2, declined: 0 }] });
    expect(advice).toMatchObject({ action: "counter", priceCents: 17500, basis: "no_history" });
  });

  it("pushes the counter up under competition and never below a rival offer", () => {
    const advice = adviseNegotiation({ ...base, offerCents: 14000, otherOffers24h: 3, topOtherOfferCents: 19600 });
    expect(advice.action).toBe("counter");
    expect(advice.priceCents).toBe(19600);
    expect(advice.basis).toBe("demand");
  });

  it("recommends accepting when the offer already meets the target", () => {
    const advice = adviseNegotiation({
      ...base,
      offerCents: 17500,
      counterBands: [{ band: "80-89", accepted: 6, declined: 1 }],
    });
    expect(advice).toMatchObject({ action: "accept", priceCents: 17500 });
  });

  it("never counters above the ask", () => {
    const advice = adviseNegotiation({ ...base, offerCents: 19000, otherOffers24h: 5, topOtherOfferCents: 25000 });
    expect(advice.priceCents).toBeLessThanOrEqual(20000);
  });
});

describe("insightSmsLine", () => {
  it("uses the SMS command grammar with whole dollars", () => {
    const insight = {
      offerId: "O7",
      advice: { action: "counter", priceCents: 10800, basis: "history", reasons: ["2 other offers in 24h"] },
    } as NegotiationInsight;
    expect(insightSmsLine(insight)).toBe("Tip: 2 other offers in 24h. Try COUNTER O7 108.");
  });
});

describe("query", () => {
  it("escapes literals", () => {
    expect(lit("D2'; DROP")).toBe("'D2''; DROP'");
  });
});
