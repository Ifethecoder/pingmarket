import assert from "node:assert/strict";
import test from "node:test";
import { createNegotiationService, type NegotiationCommand, type NegotiationResult, type NegotiationStore, type Offer } from "../../src/lib/negotiation/service.ts";

function fixture() {
  let time = 1000;
  let failNotification = false;
  let state = {
    listing: { sellerId: "seller", status: "available" as "available" | "reserved" | "sold" | "removed" },
    offers: new Map<string, Offer>(), orders: [] as { id: string; offer: Offer; status: "pending_payment" }[],
    notifications: [] as { participantId: string; body: string }[],
    requests: new Map<string, { input: string; result: NegotiationResult }>(),
  };
  // Test-only global serialization models the required transaction boundary.
  // It does not test SQL locking, multi-process workers, or crash recovery.
  let queue: Promise<unknown> = Promise.resolve();
  const service = (actorId: string) => {
    const store: NegotiationStore = {
      execute(requestId, command, work) {
        const run = queue.then(async () => {
          const key = `${actorId}:test:${requestId}`;
          const input = JSON.stringify(command);
          const previous = state.requests.get(key);
          if (previous) {
            if (previous.input !== input) throw new Error("Idempotency conflict");
            return structuredClone(previous.result);
          }
          const staged = structuredClone(state);
          const result = await work({
            actorId,
            async lockListing(code) { return code === "D1" ? staged.listing : null; },
            async lockOffer(code) { const offer = staged.offers.get(code); return offer ? { offer, listingStatus: staged.listing.status } : null; },
            async createOffer(fields) {
              const offer = { ...fields, code: `O${staged.offers.size + 1}` };
              staged.offers.set(offer.code, offer);
              return offer;
            },
            async saveOffer(offer) { staged.offers.set(offer.code, offer); },
            async reserveAndCreateOrder(offer) {
              assert.equal(staged.listing.status, "available");
              staged.listing.status = "reserved";
              const orderId = `order-${staged.orders.length + 1}`;
              staged.orders.push({ id: orderId, offer: structuredClone(offer), status: "pending_payment" });
              for (const other of staged.offers.values()) {
                if (other.code !== offer.code && ["open", "countered"].includes(other.status)) {
                  other.status = "closed";
                  other.version++;
                }
              }
              return { orderId };
            },
            async notify(participantId, body) {
              if (failNotification) throw new Error("notification storage failed");
              staged.notifications.push({ participantId, body });
            },
          });
          staged.requests.set(key, { input, result: structuredClone(result) });
          state = staged;
          return structuredClone(result);
        });
        queue = run.catch(() => {});
        return run;
      },
    };
    return createNegotiationService(store, { offerLifetimeMs: 60_000, now: () => time });
  };
  return { service, state: () => state, advance(ms: number) { time += ms; }, fail(value: boolean) { failNotification = value; } };
}
const offer: NegotiationCommand = { type: "offer", listingCode: "D1", priceCents: 10000 };
const accept: NegotiationCommand = { type: "accept", offerCode: "O1", expectedVersion: 1 };
function reason(result: NegotiationResult) { assert.equal(result.status, "rejected"); return result.status === "rejected" ? result.reason : undefined; }

test("buyer offers $100, seller counters $110, buyer accepts one pending-payment order", async () => {
  const f = fixture();
  const buyer = f.service("buyer"), seller = f.service("seller");
  await buyer.execute("offer", offer);
  await seller.execute("counter", { type: "counter", offerCode: "O1", priceCents: 11000, expectedVersion: 1 });
  const result = await buyer.execute("accept", { ...accept, expectedVersion: 2 });
  assert.equal(result.status, "ok");
  assert.equal(f.state().orders.length, 1);
  assert.equal(f.state().orders[0].offer.priceCents, 11000);
  assert.equal(f.state().orders[0].status, "pending_payment");
  assert.equal(f.state().listing.status, "reserved");
  assert.deepEqual(f.state().notifications.map(n => n.participantId), ["seller", "buyer", "seller"]);
  f.advance(100_000);
  const repeated = await buyer.execute("another-accept", { ...accept, expectedVersion: 1 });
  assert.deepEqual(repeated, result);
  assert.equal(f.state().orders.length, 1);
  assert.equal(f.state().notifications.length, 3);
});

test("self offers, outsiders, and the proposal author cannot act as the recipient", async () => {
  const f = fixture();
  assert.equal(reason(await f.service("seller").execute("self", offer)), "forbidden");
  await f.service("buyer").execute("offer", offer);
  for (const actor of ["buyer", "stranger"]) {
    for (const type of ["accept", "decline", "counter"] as const) {
      assert.equal(reason(await f.service(actor).execute(type, { type, offerCode: "O1", expectedVersion: 1, priceCents: 11000 })), "forbidden");
    }
  }
  await f.service("seller").execute("counter", { type: "counter", offerCode: "O1", expectedVersion: 1, priceCents: 11000 });
  assert.equal(reason(await f.service("seller").execute("accept", { ...accept, expectedVersion: 2 })), "forbidden");
  assert.equal(reason(await f.service("buyer").execute("counter-back", { type: "counter", offerCode: "O1", expectedVersion: 2, priceCents: 10500 })), "forbidden");
  assert.equal(f.state().orders.length, 0);
});

test("expiry, stale versions, invalid prices, missing listings and unavailable listings reject safely", async () => {
  const f = fixture();
  for (const priceCents of [0, -1, 1.1, NaN, 100_000_001]) {
    assert.equal(reason(await f.service("buyer").execute("invalid", { ...offer, priceCents })), "invalid");
  }
  assert.equal(reason(await f.service("buyer").execute("missing", { ...offer, listingCode: "D9" })), "not_found");
  await f.service("buyer").execute("offer", offer);
  assert.equal(reason(await f.service("seller").execute("stale", { ...accept, expectedVersion: 2 })), "stale");
  f.advance(60_000);
  assert.equal(reason(await f.service("seller").execute("expired", accept)), "expired");
  for (const status of ["reserved", "sold", "removed"] as const) {
    f.state().listing.status = status;
    assert.equal(reason(await f.service("buyer").execute(status, offer)), "unavailable");
  }
  assert.equal(f.state().orders.length, 0);
});

test("decline closes an offer without reserving inventory", async () => {
  const f = fixture();
  await f.service("buyer").execute("offer", offer);
  await f.service("seller").execute("decline", { ...accept, type: "decline" });
  assert.equal(f.state().offers.get("O1")!.status, "declined");
  assert.equal(reason(await f.service("seller").execute("accept", accept)), "closed");
  assert.equal(f.state().listing.status, "available");
});

test("request replay is actor scoped and changed input cannot reuse a key", async () => {
  const f = fixture();
  const buyer = f.service("buyer");
  const result = await buyer.execute("same", offer);
  assert.deepEqual(await buyer.execute("same", offer), result);
  await assert.rejects(buyer.execute("same", { ...offer, priceCents: 20000 }), /Idempotency conflict/);
  await f.service("buyer-2").execute("same", offer);
  assert.equal(f.state().offers.size, 2);
  assert.equal(f.state().notifications.length, 2);
});

test("failed notification persistence rolls back order, reservation and acceptance before retry", async () => {
  const f = fixture();
  await f.service("buyer").execute("offer", offer);
  f.fail(true);
  await assert.rejects(f.service("seller").execute("accept", accept), /notification storage failed/);
  assert.equal(f.state().orders.length, 0);
  assert.equal(f.state().listing.status, "available");
  assert.equal(f.state().offers.get("O1")!.status, "open");
  f.fail(false);
  await f.service("seller").execute("accept", accept);
  assert.equal(f.state().orders.length, 1);
});

test("serialized competing acceptances yield one order and close the other offer", async () => {
  const f = fixture();
  await f.service("buyer").execute("offer", offer);
  await f.service("buyer-2").execute("offer", offer);
  const results = await Promise.all([
    f.service("seller").execute("accept-1", accept),
    f.service("seller").execute("accept-2", { ...accept, offerCode: "O2" }),
  ]);
  assert.equal(results.filter(result => result.status === "ok").length, 1);
  assert.equal(f.state().orders.length, 1);
  assert.equal(f.state().offers.get("O2")!.status, "closed");
});
