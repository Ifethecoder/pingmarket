import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db";
import { createTestDb } from "../db/testing";
import { listTraceEvents } from "../events/service";
import { getListing } from "../listings/service";
import { createOffer, getOffer, listOffers } from "../offers/service";
import { listOrders } from "../orders/service";
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
    expect(accepted.outbound[1].body).toMatch(/accepted at \$55\.00/);
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
