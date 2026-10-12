import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db";
import { createTestDb } from "../db/testing";
import { listTraceEvents } from "../events/service";
import { getListing } from "../listings/service";
import { createOffer, getOffer, listOffers } from "../offers/service";
import { acceptOffer } from "../negotiation/db-service";
import { listOrders } from "../orders/service";
import { applyPaidCheckoutSession } from "../payments/stripe";
import { notifyTransition } from "./notify";
import completedFixture from "../darwin/__fixtures__/completed.json";
import {
  getSimHandset,
  listSimThread,
  resetSimSessions,
  SIM_SERVICE_NUMBER,
  simulateSms,
  type NegotiationPort,
} from "./simulator";

let db: Db;

const darwinFetch = () =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(completedFixture), { status: 200, headers: { "Content-Type": "application/json" } }),
  ) as unknown as typeof fetch;

const failingFetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(() => resetSimSessions());

describe("simulateSms", () => {
  it("stores the inbound text and a reply with sim_ event ids on fake numbers", async () => {
    const res = await simulateSms({ actor: "buyer", body: "HELP" }, { db });
    expect(res.inbound.direction).toBe("inbound");
    expect(res.inbound.dialEventId).toMatch(/^sim_/);
    expect(res.inbound.toNumber).toBe(SIM_SERVICE_NUMBER);
    expect(res.outbound).toHaveLength(1);
    expect(res.outbound[0].direction).toBe("outbound");
    expect(res.outbound[0].body).toContain("SEARCH");
    expect(res.outbound[0].toNumber).toBe(res.inbound.fromNumber);

    const trace = await listTraceEvents(10, db);
    const inbound = trace.find((e) => e.id === `message:${res.inbound.id}`);
    expect(inbound?.kind).toBe("sms_inbound");
    expect(inbound?.summary.startsWith("SIM ")).toBe(true);
    expect(inbound?.detail?.simulated).toBe(true);
  });

  it("uses the seeded simulated seller, never the dashboard demo seller", async () => {
    const seller = await getSimHandset("seller", db);
    expect(seller.userId).toBe("u_seller_2");
    expect(seller.userId).not.toBe("u_seller_demo");
    const buyer = await getSimHandset("buyer", db);
    expect(buyer.userId).toBe("u_web_buyer");
    expect(buyer.number).not.toBe(seller.number);
  });

  it("SELL creates a listing owned by the simulated seller in the texted marketplace", async () => {
    const res = await simulateSms(
      { actor: "seller", body: "SELL oak desk, $120, Berkeley. Pickup only.", marketplaceId: "furniture" },
      { db },
    );
    const match = /Listed (D\d+) oak desk/.exec(res.outbound[0].body);
    expect(match).not.toBeNull();
    const listing = await getListing(match![1], db);
    expect(listing).toMatchObject({
      sellerId: "u_seller_2",
      marketplaceId: "furniture",
      priceCents: 12000,
      location: "Berkeley",
      description: "Pickup only.",
      status: "available",
    });
  });

  it("walks an incomplete SELL through clarification, then lists", async () => {
    const first = await simulateSms({ actor: "seller", body: "SELL brass lamp", marketplaceId: "creative" }, { db });
    expect(first.outbound[0].body).toMatch(/What price/);
    const second = await simulateSms({ actor: "seller", body: "$45" }, { db });
    expect(second.outbound[0].body).toMatch(/Where is it/);
    const third = await simulateSms({ actor: "seller", body: "Oakland" }, { db });
    const match = /Listed (D\d+) brass lamp/.exec(third.outbound[0].body);
    expect(match).not.toBeNull();
    expect(await getListing(match![1], db)).toMatchObject({ marketplaceId: "creative", priceCents: 4500, location: "Oakland" });
  });

  it("CANCEL drops a draft; the buyer phone cannot SELL", async () => {
    await simulateSms({ actor: "seller", body: "SELL thing" }, { db });
    const cancelled = await simulateSms({ actor: "seller", body: "CANCEL" }, { db });
    expect(cancelled.outbound[0].body).toBe("Listing cancelled.");
    const buyer = await simulateSms({ actor: "buyer", body: "SELL thing, $5, Here" }, { db });
    expect(buyer.outbound[0].body).toMatch(/buyer handset/);
  });

  it("SEARCH replies with native listings and Darwin agents, and AGENT n describes one", async () => {
    const res = await simulateSms(
      { actor: "buyer", body: "SEARCH desk under $150 in Berkeley", marketplaceId: "furniture" },
      { db, search: { fetchImpl: darwinFetch() } },
    );
    const body = res.outbound[0].body;
    expect(body).toMatch(/1\) D1 Oak desk/);
    expect(body).toMatch(/Reply OFFER D1 \d+/);
    expect(body).toMatch(/external agent/);
    const agent = await simulateSms({ actor: "buyer", body: "AGENT 1" }, { db });
    expect(agent.outbound[0].body).toMatch(/Not PingMarket inventory/);
    expect(agent.outbound[0].body).toMatch(/https?:\/\//);
  });

  it("SEARCH degrades honestly when Darwin is unreachable", async () => {
    const res = await simulateSms(
      { actor: "buyer", body: "SEARCH office chair" },
      { db, search: { fetchImpl: failingFetch } },
    );
    expect(res.outbound[0].body).toMatch(/D2 Ergonomic office chair/);
    expect(res.outbound[0].body).toMatch(/unavailable right now/);
  });

  it("OFFER on the simulated seller's listing notifies the seller handset as web_simulated", async () => {
    const seller = await getSimHandset("seller", db);
    const res = await simulateSms({ actor: "buyer", body: "OFFER D2 80" }, { db });
    expect(res.outbound).toHaveLength(2);
    const match = /Offer (O\d+) sent: \$80\.00 for D2/.exec(res.outbound[0].body);
    expect(match).not.toBeNull();
    expect(res.outbound[1].toNumber).toBe(seller.number);
    expect(res.outbound[1].body).toMatch(new RegExp(`New offer ${match![1]} on D2 .*ACCEPT ${match![1]}`));

    const [offer] = (await listOffers({ listingId: "D2" }, db)).filter((o) => o.id === match![1]);
    expect(offer).toMatchObject({ buyerId: "u_web_buyer", source: "web_simulated", status: "open" });

    const sellerThread = await listSimThread("seller", db);
    expect(sellerThread.at(-1)?.id).toBe(res.outbound[1].id);
  });

  it("OFFER on the dashboard demo seller's listing sends no simulated notification", async () => {
    const res = await simulateSms({ actor: "buyer", body: "OFFER D1 100" }, { db });
    expect(res.outbound).toHaveLength(1);
    expect(res.outbound[0].body).toMatch(/not on the simulated seller phone/);
  });

  it("maps offer errors to plain replies", async () => {
    const missing = await simulateSms({ actor: "buyer", body: "OFFER D999 10" }, { db });
    expect(missing.outbound[0].body).toMatch(/No listing D999/);
    const seller = await simulateSms({ actor: "seller", body: "OFFER D1 10" }, { db });
    expect(seller.outbound[0].body).toMatch(/seller handset/);
  });

  it("REMOVE only works for the owning seller phone", async () => {
    const notMine = await simulateSms({ actor: "seller", body: "REMOVE D1" }, { db });
    expect(notMine.outbound[0].body).toMatch(/isn't your listing/);
    const mine = await simulateSms({ actor: "seller", body: "REMOVE D8" }, { db });
    expect(mine.outbound[0].body).toBe("D8 removed.");
    expect((await getListing("D8", db))?.status).toBe("removed");
    const buyer = await simulateSms({ actor: "buyer", body: "REMOVE D4" }, { db });
    expect(buyer.outbound[0].body).toMatch(/Only the seller phone/);
  });

  it("negotiates through the drizzle service by default: counter, accept, order, competing offers declined", async () => {
    const first = await simulateSms({ actor: "buyer", body: "OFFER D6 40" }, { db });
    const offerId = /Offer (O\d+) sent/.exec(first.outbound[0].body)![1];
    const competing = await createOffer({ listingId: "D6", priceCents: 4500 }, db);

    const notYours = await simulateSms({ actor: "seller", body: "ACCEPT O2" }, { db });
    expect(notYours.outbound[0].body).toMatch(/Couldn't ACCEPT O2: Offer O2 isn't yours/);

    const countered = await simulateSms({ actor: "seller", body: `COUNTER ${offerId} 55` }, { db });
    expect(countered.outbound[0].body).toBe(`Offer ${offerId} is now countered at $55.00.`);
    expect(countered.outbound[1].body).toMatch(new RegExp(`ACCEPT ${offerId}`));

    const accepted = await simulateSms({ actor: "buyer", body: `ACCEPT ${offerId}` }, { db });
    expect(accepted.outbound[0].body).toMatch(new RegExp(`^Accepted ${offerId} at \\$55\\.00 for D6\\. Order ORD\\d+ is pending payment\\.`));
    expect(accepted.outbound[1].body).toMatch(new RegExp(`^The buyer accepted your counter ${offerId}: \\$55\\.00 for D6\\. Order ORD\\d+`));
    expect((await getOffer(offerId, db))?.status).toBe("accepted");
    expect((await getOffer(competing.id, db))?.status).toBe("declined");
    expect((await getListing("D6", db))?.status).toBe("reserved");
    expect((await listOrders(db)).some((o) => o.offerId === offerId && o.amountCents === 5500)).toBe(true);
  });

  it("routes negotiation through the port and notifies the counterpart", async () => {
    const buyer = await getSimHandset("buyer", db);
    const created = await simulateSms({ actor: "buyer", body: "OFFER D4 50" }, { db });
    const offerId = /Offer (O\d+) sent/.exec(created.outbound[0].body)![1];
    const negotiation: NegotiationPort = {
      counter: vi.fn(async ({ offerId, priceCents }) => ({
        ...(await listOffers({}, db)).find((o) => o.id === offerId)!,
        status: "countered" as const,
        proposedPriceCents: priceCents,
      })),
      accept: vi.fn(),
      decline: vi.fn(),
    };
    const res = await simulateSms({ actor: "seller", body: `COUNTER ${offerId} 70` }, { db, negotiation });
    expect(negotiation.counter).toHaveBeenCalledWith({ offerId, actorId: "u_seller_2", priceCents: 7000 }, db);
    expect(res.outbound[0].body).toMatch(/countered at \$70\.00/);
    expect(res.outbound[1].toNumber).toBe(buyer.number);
    expect(res.outbound[1].body).toMatch(new RegExp(`ACCEPT ${offerId}`));
  });

  it("unknown text gets a HELP hint and router failures never leak", async () => {
    const res = await simulateSms({ actor: "buyer", body: "hello there" }, { db });
    expect(res.outbound[0].body).toMatch(/Reply HELP/);
  });
});

describe("both handsets see the whole transaction", () => {
  beforeEach(() => vi.stubEnv("STRIPE_SECRET_KEY", ""));

  const bodiesSince = async (actor: "buyer" | "seller", since: number) =>
    (await listSimThread(actor, db)).slice(since).map((m) => m.body);

  async function newListing(title: string, price: number): Promise<string> {
    const res = await simulateSms({ actor: "seller", body: `SELL ${title}, $${price}, Berkeley` }, { db });
    return /Listed (D\d+)/.exec(res.outbound[0].body)![1];
  }

  it("offer → counter → accept → payment: each phone gets its side's texts, in order", async () => {
    const listingId = await newListing("walnut bookshelf", 200);
    const seller0 = (await listSimThread("seller", db)).length;
    const buyer0 = (await listSimThread("buyer", db)).length;

    const offered = await simulateSms({ actor: "buyer", body: `OFFER ${listingId} 150` }, { db });
    const offerId = /Offer (O\d+) sent/.exec(offered.outbound[0].body)![1];
    await simulateSms({ actor: "seller", body: `COUNTER ${offerId} 180` }, { db });
    await simulateSms({ actor: "buyer", body: `ACCEPT ${offerId}` }, { db });
    const order = (await listOrders(db)).find((o) => o.offerId === offerId)!;

    const result = await applyPaidCheckoutSession(
      {
        id: "cs_test_sim_flow",
        livemode: false,
        client_reference_id: order.id,
        metadata: { orderId: order.id, offerId },
        payment_status: "paid",
        amount_total: 18000,
        currency: "usd",
      },
      { db },
    );
    expect(result.outcome).toBe("paid");

    const buyer = await bodiesSince("buyer", buyer0);
    expect(buyer).toEqual([
      `OFFER ${listingId} 150`,
      expect.stringMatching(new RegExp(`^Offer ${offerId} sent: \\$150\\.00 for ${listingId}`)),
      `Counter ${offerId}: $180.00 for ${listingId} (walnut bookshelf). Reply ACCEPT ${offerId} or DECLINE ${offerId}.`,
      `ACCEPT ${offerId}`,
      `Accepted ${offerId} at $180.00 for ${listingId}. Order ${order.id} is pending payment. Pay on the PingMarket dashboard.`,
      `Payment received: $180.00 for ${listingId} (walnut bookshelf). Order ${order.id} is confirmed and the seller has been told.`,
    ]);
    const seller = await bodiesSince("seller", seller0);
    expect(seller).toEqual([
      expect.stringMatching(new RegExp(`^New offer ${offerId} on ${listingId} \\(walnut bookshelf\\): \\$150\\.00, asking \\$200\\.00`)),
      `COUNTER ${offerId} 180`,
      `Offer ${offerId} is now countered at $180.00.`,
      `The buyer accepted your counter ${offerId}: $180.00 for ${listingId}. Order ${order.id} is pending payment; we'll text you when they pay.`,
      `Sold! The buyer paid $180.00 for ${listingId} (walnut bookshelf), order ${order.id}. Your payout is pending.`,
    ]);

    // A repeated confirmation (webhook + redirect) texts nobody again.
    const again = await applyPaidCheckoutSession(
      { id: "cs_test_sim_flow", livemode: false, client_reference_id: order.id, metadata: {}, payment_status: "paid", amount_total: 18000, currency: "usd" },
      { db },
    );
    expect(again.outcome).toBe("paid");
    expect(await bodiesSince("buyer", buyer0)).toHaveLength(buyer.length);
    expect(await bodiesSince("seller", seller0)).toHaveLength(seller.length);
  });

  it("seller ACCEPT on the phone sends the buyer the accepted text and declines the buyer's competing offer", async () => {
    const listingId = await newListing("teak stool", 60);
    const first = await simulateSms({ actor: "buyer", body: `OFFER ${listingId} 40` }, { db });
    const losing = /Offer (O\d+) sent/.exec(first.outbound[0].body)![1];
    const second = await simulateSms({ actor: "buyer", body: `OFFER ${listingId} 50` }, { db });
    const winning = /Offer (O\d+) sent/.exec(second.outbound[0].body)![1];
    const buyer0 = (await listSimThread("buyer", db)).length;

    const res = await simulateSms({ actor: "seller", body: `ACCEPT ${winning}` }, { db });
    expect(res.outbound[0].body).toMatch(new RegExp(`^Offer ${winning} is now accepted at \\$50\\.00\\. Order ORD\\d+ is pending payment; we'll text you when the buyer pays\\.`));
    expect(await bodiesSince("buyer", buyer0)).toEqual([
      expect.stringMatching(new RegExp(`^Accepted ${winning} at \\$50\\.00 for ${listingId}\\. Order ORD\\d+ is pending payment\\.`)),
      `Offer ${losing} on ${listingId} was declined.`,
    ]);
  });

  it("dashboard moves reach the handsets too", async () => {
    const listingId = await newListing("cane chair", 90);
    const buyer = await getSimHandset("buyer", db);
    const offer = await createOffer({ listingId, priceCents: 7000 }, db);
    expect(offer.buyerId).toBe(buyer.userId);
    const buyer0 = (await listSimThread("buyer", db)).length;

    const outcome = await acceptOffer({ offerId: offer.id, actorId: offer.sellerId }, db);
    await notifyTransition({ offer: outcome.offer, actorId: offer.sellerId, declined: outcome.declined }, db);
    const [text] = await bodiesSince("buyer", buyer0);
    expect(text).toMatch(new RegExp(`^Accepted ${offer.id} at \\$70\\.00 for ${listingId}\\. Order ORD\\d+ is pending payment\\.`));
  });

  it("the buyer declining a counter tells the seller phone", async () => {
    const listingId = await newListing("rattan lamp", 30);
    const offered = await simulateSms({ actor: "buyer", body: `OFFER ${listingId} 20` }, { db });
    const offerId = /Offer (O\d+) sent/.exec(offered.outbound[0].body)![1];
    await simulateSms({ actor: "seller", body: `COUNTER ${offerId} 25` }, { db });
    const res = await simulateSms({ actor: "buyer", body: `DECLINE ${offerId}` }, { db });
    expect(res.outbound[1].body).toBe(`The buyer declined your counter ${offerId} on ${listingId}. ${listingId} is still listed.`);
  });
});
