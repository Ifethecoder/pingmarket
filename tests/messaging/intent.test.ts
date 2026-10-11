import assert from "node:assert/strict";
import { test } from "node:test";
import { clarifyListing, parsePrice, parseSms } from "../../src/lib/sms/intent.ts";

test("both PRD examples and the supported natural wording yield the same listing", () => {
  for (const text of [
    "SELL oak desk, $120, Berkeley. Pickup only.",
    "SELL oak desk, $120, Berkeley, Pickup only.",
    "I'd like to sell my oak desk for $120 in Berkeley, Pickup only.",
  ]) assert.deepEqual(parseSms(text), {
    type: "sell", draft: { title: "oak desk", priceCents: 12000, location: "Berkeley", description: "Pickup only." }, missing: [],
  });
});
test("listing details do not invent price, location, seller, or sharing consent", () => {
  assert.deepEqual(parseSms("SELL oak desk"), { type: "sell", draft: { title: "oak desk" }, missing: ["priceCents", "location"] });
  assert.deepEqual(parseSms("SELL oak desk, $120"), { type: "sell", draft: { title: "oak desk", priceCents: 12000 }, missing: ["location"] });
  assert.deepEqual(parseSms("SELL"), { type: "sell", draft: {}, missing: ["title", "priceCents", "location"] });
});
test("money supports cents and grouped dollars without rounding", () => {
  for (const [input, cents] of [["$120.50", 12050], ["0.01", 1], ["$1,200", 120000], ["12.3", 1230]] as const) assert.equal(parsePrice(input), cents);
  for (const input of ["-1", "0", "1.001", "NaN", "1e3", "1,20", "Infinity", "$", "1000001", "999999999999999999999999"]) assert.equal(parsePrice(input), null);
});
test("listing parser handles grouped money and dotted city names", () => {
  assert.deepEqual(parseSms("SELL desk, $1,200.50, St. Louis. Pickup only."), {
    type: "sell", draft: { title: "desk", priceCents: 120050, location: "St. Louis", description: "Pickup only." }, missing: [],
  });
});
test("clarification fills one missing field while preserving earlier details", () => {
  const priced = clarifyListing({ title: "desk" }, "$120.50");
  assert.deepEqual(priced, { type: "sell", draft: { title: "desk", priceCents: 12050 }, missing: ["location"] });
  assert.deepEqual(clarifyListing({ title: "desk", priceCents: 12050 }, "Berkeley"), {
    type: "sell", draft: { title: "desk", priceCents: 12050, location: "Berkeley" }, missing: [],
  });
  assert.deepEqual(clarifyListing({ title: "desk" }, "CANCEL"), { type: "cancel" });
  assert.deepEqual(clarifyListing({ title: "desk" }, "STOP"), { type: "stop" });
  assert.equal(clarifyListing({ title: "desk" }, "-10").type, "invalid");
});
test("transaction commands are explicit and typed", () => {
  assert.deepEqual(parseSms("offer d42 $100"), { type: "offer", listingCode: "D42", priceCents: 10000 });
  assert.deepEqual(parseSms("COUNTER O7 110.50"), { type: "counter", offerCode: "O7", priceCents: 11050 });
  assert.deepEqual(parseSms("ACCEPT O7"), { type: "accept", offerCode: "O7" });
  assert.deepEqual(parseSms("DECLINE O7"), { type: "decline", offerCode: "O7" });
  assert.deepEqual(parseSms("REMOVE D42"), { type: "remove", listingCode: "D42" });
});
test("malformed transactions never become inferred listing or search operations", () => {
  for (const text of ["OFFER D42 -1", "OFFER D42 1.005", "OFFER D42 100 ACCEPT O7", "COUNTER D42 110", "ACCEPT O7 please", "ACCEPT", "REMOVE O7", "AGENT 0"]) {
    assert.equal(parseSms(text).type, "invalid", text);
  }
  assert.equal(parseSms("I accept whatever price the seller wants").type, "unrecognized");
});
test("search and lookup commands retain user intent without provider calls", () => {
  const query = "Looking for a desk under $150 in Berkeley; also interested in custom wall art.";
  assert.deepEqual(parseSms(query), { type: "search", query });
  assert.deepEqual(parseSms("SEARCH wall art"), { type: "search", query: "wall art" });
  assert.deepEqual(parseSms("DETAILS D42"), { type: "details", listingCode: "D42" });
  assert.deepEqual(parseSms("AGENT 1"), { type: "agent", index: 1 });
  assert.deepEqual(parseSms("EDIT D42 price $130"), { type: "edit", listingCode: "D42", changes: "price $130" });
});
test("unfamiliar text stays unrecognized; malformed prices and oversized input are rejected", () => {
  assert.equal(parseSms("hello there").type, "unrecognized");
  for (const text of ["", " ", "x".repeat(2001), "SELL desk, $-120, Berkeley", "SELL desk, $120.999, Berkeley"]) assert.equal(parseSms(text).type, "invalid");
});
