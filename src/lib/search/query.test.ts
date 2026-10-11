import { describe, expect, it } from "vitest";
import { parseBuyerQuery, parseLocation, parseMaxPriceCents, STOPWORDS } from "./query";

describe("parseMaxPriceCents", () => {
  it.each([
    ["desk under $150", 15000],
    ["chair below 150", 15000],
    ["poster <= $100", 10000],
    ["lamp max $100", 10000],
    ["lamp $150 max", 15000],
    ["shelf up to 150", 15000],
    ["shelf 150 or less", 15000],
    ["sofa budget 150", 15000],
    ["sofa less than $1,200", 120000],
    ["print under $49.50", 4950],
    ["$100 Berkeley", 10000],
  ])("%s -> %d cents", (q, cents) => {
    expect(parseMaxPriceCents(q)).toBe(cents);
  });

  it.each(["art print 24x36", "24x36 max", "desk", "2 drawers", "under 150k"])(
    "%s -> null (no price cue)",
    (q) => {
      expect(parseMaxPriceCents(q)).toBeNull();
    },
  );
});

describe("parseLocation", () => {
  it.each([
    ["desk in Berkeley", "Berkeley"],
    ["desk in berkeley", "Berkeley"],
    ["chair near Oakland", "Oakland"],
    ["poster around san francisco", "San Francisco"],
    ["poster in SF", "San Francisco"],
    ["lamp near Palo Alto", "Palo Alto"],
    ["$100 Berkeley", "Berkeley"],
  ])("%s -> %s", (q, loc) => {
    expect(parseLocation(q)).toBe(loc);
  });

  it.each(["interested in custom wall art", "desk", "in the den"])("%s -> null", (q) => {
    expect(parseLocation(q)).toBeNull();
  });
});

describe("parseBuyerQuery", () => {
  it("parses the demo query", () => {
    expect(
      parseBuyerQuery("Looking for a desk under $150 in Berkeley; also interested in custom wall art."),
    ).toEqual({
      tokens: ["desk", "custom", "wall", "art"],
      maxPriceCents: 15000,
      location: "Berkeley",
    });
  });

  it("singularizes, dedupes and drops numbers", () => {
    expect(parseBuyerQuery("Desks, desk, posters, glass 24x36 2 3").tokens).toEqual([
      "desk",
      "poster",
      "glass",
      "24x36",
    ]);
  });

  it("returns zero tokens for a price + location only query", () => {
    expect(parseBuyerQuery("$100 Berkeley")).toEqual({
      tokens: [],
      maxPriceCents: 10000,
      location: "Berkeley",
    });
  });

  it("exports the stopword list", () => {
    expect(STOPWORDS.has("looking")).toBe(true);
    expect(STOPWORDS.has("desk")).toBe(false);
  });
});
