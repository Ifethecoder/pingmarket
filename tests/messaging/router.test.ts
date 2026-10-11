import assert from "node:assert/strict";
import test from "node:test";
import { createSellerRouter, type NewSellerListing, type SellerContext, type SellerConversation, type SellerMessageStore } from "../../src/lib/sms/router.ts";
import type { ReceivedSms } from "../../src/lib/sms/ports.ts";

// Test-only transactional adapter. Not an application persistence fallback.
function fixture() {
  let now = Date.parse("2026-10-11T12:00:00Z");
  let sequence = 0;
  let failReply = false;
  const actors = new Map<string, SellerContext>();
  const messages = new Map<string, ReceivedSms>();
  let state = {
    conversations: new Map<string, SellerConversation>(),
    listings: [] as NewSellerListing[], replies: [] as string[],
    events: new Set<string>(), providerMessages: new Set<string>(),
  };
  const store: SellerMessageStore = {
    async process(eventId, work) {
      const message = messages.get(eventId)!;
      if (state.events.has(eventId) || state.providerMessages.has(message.messageId)) return "duplicate";
      const staged = structuredClone(state);
      const scope = `${message.from}:${message.to}`;
      await work(message, {
        actor: actors.get(message.from) ?? { participantId: message.from, marketplaceId: "furniture" },
        conversation: staged.conversations.get(scope) ?? {},
        async createListing(listing) { staged.listings.push(listing); return { code: `D${staged.listings.length}` }; },
        async saveConversation(conversation) { staged.conversations.set(scope, conversation); },
        async enqueueReply(body) { if (failReply) throw new Error("storage failed"); staged.replies.push(body); },
      });
      staged.events.add(eventId);
      staged.providerMessages.add(message.messageId);
      state = staged;
      return "processed";
    },
  };
  const router = createSellerRouter(store, () => now);
  return {
    router, actors, messages,
    state: () => state,
    advance(ms: number) { now += ms; },
    failReply(value: boolean) { failReply = value; },
    receive(body: string, override: Partial<ReceivedSms> = {}) {
      const id = String(++sequence);
      const message: ReceivedSms = { eventId: id, messageId: `m${id}`, from: "+15550000001", to: "+15550000002", body, occurredAt: new Date(now).toISOString(), source: "dial_sms", providerSource: "external", ...override };
      messages.set(message.eventId, message);
      return message.eventId;
    },
  };
}

test("both PRD formats and natural SELL create owned listings with confirmation", async () => {
  for (const body of ["SELL oak desk, $120, Berkeley. Pickup only.", "SELL oak desk, $120, Berkeley, pickup only.", "I'd like to sell my oak desk for $120 in Berkeley, pickup only."]) {
    const f = fixture();
    await f.router.process(f.receive(body));
    const listing = f.state().listings[0];
    assert.equal(listing.title, "oak desk");
    assert.equal(listing.priceCents, 12000);
    assert.equal(listing.location, "Berkeley");
    assert.equal(listing.sellerId, "+15550000001");
    assert.equal(listing.visibility, "marketplace_only");
    assert.match(f.state().replies[0], /Listed D1.*\$120.00/);
  }
});

test("asks only for missing fields, rejects bad price, then completes and clears draft", async () => {
  const f = fixture();
  for (const [body, expected] of [["SELL", /title/], ["oak desk", /price/], ["-5", /positive/], ["$120.50", /located/], ["Berkeley, pickup only", /Listed D1/]] as const) {
    await f.router.process(f.receive(body));
    assert.match(f.state().replies.at(-1)!, expected);
  }
  assert.equal(f.state().listings[0].priceCents, 12050);
  assert.equal([...f.state().conversations.values()][0].draft, undefined);
});

test("drafts are scoped to both participant and service; HELP and explicit commands do not become fields", async () => {
  const f = fixture();
  await f.router.process(f.receive("SELL desk"));
  await f.router.process(f.receive("$100", { from: "+15550000003" }));
  await f.router.process(f.receive("$100", { to: "+15550000004" }));
  for (const body of ["HELP", "OFFER D42 100", "STOP"]) await f.router.process(f.receive(body));
  assert.equal(f.state().listings.length, 0);
  const draft = f.state().conversations.get("+15550000001:+15550000002")!.draft!;
  assert.deepEqual(draft.fields, { title: "desk" });
});

test("CANCEL discards a draft and expiry is fixed at thirty minutes", async () => {
  const f = fixture();
  await f.router.process(f.receive("SELL desk"));
  await f.router.process(f.receive("CANCEL"));
  await f.router.process(f.receive("$100"));
  assert.equal(f.state().listings.length, 0);
  await f.router.process(f.receive("SELL desk"));
  f.advance(29 * 60_000);
  await f.router.process(f.receive("$100"));
  f.advance(60_000);
  await f.router.process(f.receive("Berkeley"));
  assert.match(f.state().replies.at(-1)!, /expired/);
  assert.equal(f.state().listings.length, 0);
});

test("late messages cannot replace a newer draft", async () => {
  const f = fixture();
  const old = f.receive("SELL old desk, $1, Oakland");
  f.advance(1000);
  await f.router.process(f.receive("SELL new desk"));
  await f.router.process(old);
  assert.match(f.state().replies.at(-1)!, /out of order/);
  assert.equal(f.state().listings.length, 0);
  assert.equal([...f.state().conversations.values()][0].draft!.fields.title, "new desk");
});

test("recorded consent and identity come only from trusted actor context", async () => {
  const f = fixture();
  f.actors.set("+15550000001", { participantId: "seller-1", marketplaceId: "creative", crossMarketConsentId: "consent-1" });
  await f.router.process(f.receive("SELL logo design, $50, Remote"));
  assert.equal(f.state().listings[0].sellerId, "seller-1");
  assert.equal(f.state().listings[0].marketplaceId, "creative");
  assert.equal(f.state().listings[0].visibility, "cross_market");
  assert.equal(f.state().listings[0].crossMarketConsentId, "consent-1");
});

test("atomic adapter rolls back a listing on reply failure; retries and duplicate envelopes create one listing", async () => {
  const f = fixture();
  const event = f.receive("SELL desk, $120, Berkeley");
  f.failReply(true);
  await assert.rejects(f.router.process(event), /storage failed/);
  assert.equal(f.state().listings.length, 0);
  assert.equal(f.state().events.size, 0);
  f.failReply(false);
  assert.equal(await f.router.process(event), "processed");
  assert.equal(await f.router.process(event), "duplicate");
  const repeated = f.receive("SELL different desk, $200, Oakland", { messageId: f.messages.get(event)!.messageId });
  assert.equal(await f.router.process(repeated), "duplicate");
  assert.equal(f.state().listings.length, 1);
  assert.equal(f.state().replies.length, 1);
});
