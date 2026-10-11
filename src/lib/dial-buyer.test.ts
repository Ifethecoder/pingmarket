/**
 * The real SMS buyer over Dial, end to end: signed webhook → durable inbox → after() processing →
 * shared gateway → outbound rows + (fake) Dial sends; seller moves from the dashboard routes text the buyer.
 */
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as simulateInboundPOST } from "@/app/api/dial/simulate-inbound/route";
import { GET as webhookGET, POST as webhookPOST } from "@/app/api/dial/webhook/route";
import { POST as acceptPOST } from "@/app/api/offers/[id]/accept/route";
import { POST as counterPOST } from "@/app/api/offers/[id]/counter/route";
import { POST as declinePOST } from "@/app/api/offers/[id]/decline/route";
import completedFixture from "./darwin/__fixtures__/completed.json";
import type { Db } from "./db";
import { messages, orders, users } from "./db/schema";
import { createTestDb } from "./db/testing";
import { createDialRuntime, setDialRuntimeForTests, type DialRuntime } from "./dial/runtime";
import { listTraceEvents } from "./events/service";
import { getListing } from "./listings/service";
import { createOffer, getOffer } from "./offers/service";
import type { Message, Offer } from "./types";
import { NOT_REGISTERED_TEXT, processInboundSms, resetDialSessions } from "./sms/inbound";
import { createDbInbox } from "./sms/inbox";
import type { ReceivedSms, SmsSender } from "./sms/ports";

const state = vi.hoisted(() => ({ db: null as unknown, after: [] as (() => unknown)[] }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: async () => state.db,
}));
// Outside a Next request scope `after()` / `connection()` throw; collect after-callbacks and run them explicitly.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
  after: (fn: () => unknown) => {
    state.after.push(fn);
  },
}));

const SECRET = "test-dial-signing-secret";
const SERVICE = "+15550000100";
const BUYER = "+15550000011"; // seeded u_sms_buyer when DIAL_PARTICIPANT_NUMBER is unset
let db: Db;
let sent: { to: string; body: string }[];
let eventSeq = 0;

const fakeSender: SmsSender = {
  async send(to, body) {
    sent.push({ to, body });
    return { status: "accepted", providerMessageId: `dm_${sent.length}` };
  },
};

function runtime(overrides: Partial<DialRuntime> = {}): DialRuntime {
  return {
    configured: true,
    errors: [],
    serviceNumber: SERVICE,
    participantNumber: BUYER,
    webhookSecret: SECRET,
    webhookReady: true,
    sendsEnabled: true,
    sender: fakeSender,
    ...overrides,
  };
}

function signedRequest(body: string, { id = `evt_dial_${++eventSeq}`, from = BUYER, signature }: { id?: string; from?: string; signature?: string } = {}) {
  const payload = JSON.stringify({
    id,
    object: "event",
    version: 1,
    createdAt: new Date().toISOString(),
    type: "message.received",
    data: { messageId: `m_${id}`, from, to: SERVICE, body, source: "external" },
  });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", SECRET).update(`${t}.`).update(payload).digest("hex");
  return new Request("http://localhost:3000/api/dial/webhook", {
    method: "POST",
    body: payload,
    headers: {
      "content-type": "application/json",
      "x-dial-signature": signature ?? `t=${t},v1=${v1}`,
      "x-dial-event-id": id,
      "x-dial-event-type": "message.received",
    },
  });
}

async function drainAfter() {
  while (state.after.length) await state.after.shift()!();
}

/** Texts PingMarket from the buyer phone; returns the replies the fake Dial sender received. */
async function text(body: string, id?: string) {
  const before = sent.length;
  const res = await webhookPOST(signedRequest(body, { id }));
  expect(res.status).toBe(200);
  await drainAfter();
  return { status: ((await res.json()) as { status: string }).status, replies: sent.slice(before) };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
/** What the dashboard sends: same-origin JSON. */
const post = (body: unknown = {}, headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/api/offers/x", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: "http://localhost:3000", host: "localhost:3000", ...headers },
  });
const simulateInbound = (payload: unknown, headers: Record<string, string> = {}) =>
  simulateInboundPOST(
    new Request("http://localhost:3000/api/dial/simulate-inbound", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json", host: "localhost:3000", ...headers },
    }),
  );

async function storeInbound(body: string): Promise<Message> {
  const [row] = await db
    .insert(messages)
    .values({ id: `msg_${crypto.randomUUID()}`, dialEventId: `evt_direct_${crypto.randomUUID()}`, fromNumber: BUYER, toNumber: SERVICE, body, direction: "inbound" })
    .returning();
  return { ...row, createdAt: row.createdAt.toISOString() };
}

beforeAll(async () => {
  db = await createTestDb();
  state.db = db;
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(completedFixture), { status: 200, headers: { "Content-Type": "application/json" } })),
  );
});

beforeEach(() => {
  sent = [];
  state.after = [];
  setDialRuntimeForTests(runtime());
});

afterAll(() => {
  setDialRuntimeForTests(null);
  resetDialSessions();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("createDbInbox", () => {
  it("stores once per Dial event id and reports retries as duplicates", async () => {
    const stored: Message[] = [];
    const inbox = createDbInbox(db, (m) => {
      stored.push(m);
    });
    const sms: ReceivedSms = {
      eventId: "evt_inbox_dedupe",
      messageId: "m_inbox_dedupe",
      from: BUYER,
      to: SERVICE,
      body: "HELP",
      occurredAt: new Date().toISOString(),
      source: "dial_sms",
      providerSource: "external",
    };
    expect(await inbox.receive(sms)).toBe("stored");
    expect(await inbox.receive({ ...sms, body: "changed" })).toBe("duplicate");
    expect(stored).toHaveLength(1);
    const rows = await db.select().from(messages).where(eq(messages.dialEventId, "evt_inbox_dedupe"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ body: "HELP", direction: "inbound", fromNumber: BUYER, toNumber: SERVICE });
  });
});

describe("Dial runtime", () => {
  it("is unconfigured without env and never builds a sender", () => {
    const rt = createDialRuntime({});
    expect(rt.configured).toBe(false);
    expect(rt.sender).toBeNull();
    const ok = createDialRuntime({
      DIAL_API_KEY: "k",
      DIAL_SERVICE_NUMBER: SERVICE,
      DIAL_SERVICE_NUMBER_ID: "n_1",
      DIAL_PARTICIPANT_NUMBER: BUYER,
      DIAL_WEBHOOK_SECRET: SECRET,
      DIAL_SEND_ENABLED: "false",
    });
    expect(ok).toMatchObject({ configured: true, webhookReady: true, sendsEnabled: false, participantNumber: BUYER });
    expect(ok.sender).not.toBeNull();
  });
});

describe("POST /api/dial/webhook", () => {
  it("reports health without secrets and 503s when Dial is not configured", async () => {
    const health = await (await webhookGET()).json();
    expect(health).toEqual({ configured: true, webhookReady: true, sendsEnabled: true });
    setDialRuntimeForTests(runtime({ configured: false, sender: null }));
    const res = await webhookPOST(signedRequest("HELP"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "DIAL_NOT_CONFIGURED" });
  });

  it("rejects bad signatures before storing anything", async () => {
    const res = await webhookPOST(signedRequest("HELP", { id: "evt_bad_sig", signature: `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` }));
    expect(res.status).toBe(401);
    expect(await db.select().from(messages).where(eq(messages.dialEventId, "evt_bad_sig"))).toHaveLength(0);
  });

  it("SEARCH: stores the inbound row, replies after the 200, and dedupes a retried event", async () => {
    const first = await text("SEARCH office chair", "evt_search_1");
    expect(first.status).toBe("stored");
    expect(first.replies).toHaveLength(1);
    expect(first.replies[0].to).toBe(BUYER);
    expect(first.replies[0].body).toMatch(/1\) D2 Ergonomic office chair/);
    expect(first.replies[0].body).toMatch(/Reply OFFER D2 \d+/);
    expect(first.replies[0].body.length).toBeLessThanOrEqual(480);

    const retry = await text("SEARCH office chair", "evt_search_1");
    expect(retry).toEqual({ status: "duplicate", replies: [] });

    const outRows = await db.select().from(messages).where(eq(messages.toNumber, BUYER));
    const reply = outRows.find((m) => m.body === first.replies[0].body);
    expect(reply).toMatchObject({ direction: "outbound", fromNumber: SERVICE });
    expect(reply?.dialEventId).toMatch(/^dial_out_/);

    const agent = await text("AGENT 1");
    expect(agent.replies[0].body).toMatch(/Not PingMarket inventory/);
  });

  it("HELP lists buyer commands; SELL is refused for the buyer phone", async () => {
    const help = await text("HELP");
    for (const cmd of ["SEARCH", "DETAILS D2", "OFFER D2 80", "ACCEPT O7", "DECLINE O7", "AGENT 1", "STOP"]) {
      expect(help.replies[0].body).toContain(cmd);
    }
    const sell = await text("SELL oak desk, $120, Berkeley");
    expect(sell.replies[0].body).toMatch(/^This number is registered as a buyer/);
    expect(sell.replies[0].body).not.toMatch(/simulat/i);
  });

  it("OFFER → seller counter on the dashboard → buyer ACCEPT by SMS creates the order", async () => {
    const offered = await text("OFFER D2 80");
    const offerId = /Offer (O\d+) sent: \$80\.00 for D2/.exec(offered.replies[0].body)?.[1];
    expect(offerId).toBeDefined();
    expect(offered.replies[0].body).not.toMatch(/simulat/i);
    expect(await getOffer(offerId!, db)).toMatchObject({ buyerId: "u_sms_buyer", source: "sms", status: "open" });
    const competing = await createOffer({ listingId: "D2", priceCents: 7000 }, db);

    const bad = await counterPOST(post({ priceCents: -5 }), params(offerId!));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "INVALID_PRICE" });

    const countered = await counterPOST(post({ priceCents: 9000 }), params(offerId!));
    expect(countered.status).toBe(200);
    expect(((await countered.json()) as { offer: Offer }).offer).toMatchObject({ status: "countered", proposedPriceCents: 9000 });
    expect(sent.at(-1)).toEqual({
      to: BUYER,
      body: `Counter ${offerId}: $90.00 for D2 (Ergonomic office chair). Reply ACCEPT ${offerId} or DECLINE ${offerId}.`,
    });

    // The dashboard can't answer for the SMS buyer.
    for (const route of [acceptPOST, declinePOST]) {
      const res = await route(post(), params(offerId!));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "SMS_BUYER_ONLY" });
    }
    expect((await getOffer(offerId!, db))?.status).toBe("countered");

    const accepted = await text(`ACCEPT ${offerId}`);
    expect(accepted.replies).toHaveLength(1);
    expect(accepted.replies[0].body).toMatch(
      new RegExp(`^Accepted ${offerId} at \\$90\\.00 for D2\\. Order (ORD\\d+) is pending payment\\. Pay on the PingMarket dashboard\\.$`),
    );
    const orderId = /Order (ORD\d+)/.exec(accepted.replies[0].body)![1];
    expect(await getOffer(offerId!, db)).toMatchObject({ status: "accepted", lastActorId: "u_sms_buyer" });
    expect((await getOffer(competing.id, db))?.status).toBe("declined");
    expect((await getListing("D2", db))?.status).toBe("reserved");
    const [order] = await db.select().from(orders).where(eq(orders.offerId, offerId!));
    expect(order).toMatchObject({ id: orderId, amountCents: 9000, paymentStatus: "pending" });

    const trace = await listTraceEvents(200, db);
    const dialRows = trace.filter((e) => e.kind.startsWith("sms_") && e.detail?.channel === "dial");
    expect(dialRows.length).toBeGreaterThan(0);
    expect(dialRows.every((e) => e.summary.startsWith("SMS ") && !e.summary.includes(BUYER))).toBe(true);
  });

  it("dashboard accept / decline of an open SMS offer texts the buyer", async () => {
    const declineId = /Offer (O\d+) sent/.exec((await text("OFFER D3 150")).replies[0].body)![1];
    const declined = await declinePOST(post(), params(declineId));
    expect(declined.status).toBe(200);
    expect(sent.at(-1)).toEqual({ to: BUYER, body: `Offer ${declineId} on D3 was declined.` });

    const acceptId = /Offer (O\d+) sent/.exec((await text("OFFER D5 40")).replies[0].body)![1];
    const accepted = await acceptPOST(post(), params(acceptId));
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { offer: Offer }).offer.status).toBe("accepted");
    expect(sent.at(-1)?.body).toMatch(new RegExp(`^Accepted ${acceptId} at \\$40\\.00 for D5\\. Order ORD\\d+ is pending payment\\.`));

    // Repeated accept is idempotent and does not text again.
    const before = sent.length;
    expect((await acceptPOST(post(), params(acceptId))).status).toBe(200);
    expect(sent.length).toBe(before);

    const closed = await declinePOST(post(), params(acceptId));
    expect(closed.status).toBe(409);
    expect(await closed.json()).toMatchObject({ code: "OFFER_CLOSED" });
    expect((await acceptPOST(post(), params("O999999"))).status).toBe(404);
  });

  it("web-buyer offers are still answered from the dashboard, without any SMS", async () => {
    const offer = await createOffer({ listingId: "D1", priceCents: 9000 }, db);
    expect((await counterPOST(post({ priceCents: 10000 }), params(offer.id))).status).toBe(200);
    const res = await acceptPOST(post(), params(offer.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { offer: Offer }).offer).toMatchObject({ status: "accepted", lastActorId: "u_web_buyer" });
    expect(sent).toHaveLength(0);
  });

  it("offer routes refuse cross-site form posts and foreign origins", async () => {
    const offer = await createOffer({ listingId: "D8", priceCents: 3000 }, db);
    const form = new Request("http://localhost:3000/api/offers/x", {
      method: "POST",
      body: "priceCents=1",
      headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost:3000" },
    });
    expect((await acceptPOST(form, params(offer.id))).status).toBe(403);
    const noBody = new Request("http://localhost:3000/api/offers/x", { method: "POST", headers: { host: "localhost:3000" } });
    expect((await declinePOST(noBody, params(offer.id))).status).toBe(403);
    const foreign = await counterPOST(post({ priceCents: 3500 }, { origin: "https://evil.example" }), params(offer.id));
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ code: "FORBIDDEN" });
    expect((await getOffer(offer.id, db))?.status).toBe("open");
    // Same-origin JSON without an Origin header (e.g. curl) is fine.
    const ok = await declinePOST(
      new Request("http://localhost:3000/api/offers/x", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json", host: "localhost:3000" },
      }),
      params(offer.id),
    );
    expect(ok.status).toBe(200);
  });

  it("accepting one offer texts SMS buyers whose competing offers were declined", async () => {
    const first = /Offer (O\d+) sent/.exec((await text("OFFER D4 50")).replies[0].body)![1];
    const second = /Offer (O\d+) sent/.exec((await text("OFFER D4 60")).replies[0].body)![1];
    const web = await createOffer({ listingId: "D4", priceCents: 55 * 100 }, db);
    const before = sent.length;
    const res = await acceptPOST(post(), params(second));
    expect(res.status).toBe(200);
    const texts = sent.slice(before).map((m) => m.body);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatch(new RegExp(`^Accepted ${second} at \\$60\\.00 for D4\\.`));
    expect(texts[1]).toBe(`Offer ${first} on D4 was declined.`);
    expect((await getOffer(web.id, db))?.status).toBe("declined");

    // A double click returns the accepted offer without texting again.
    const again = await acceptPOST(post(), params(second));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { offer: Offer }).offer.status).toBe("accepted");
    expect(sent.length).toBe(before + 2);
  });

  it("processes texts from one phone in arrival order", async () => {
    resetDialSessions();
    const search = await storeInbound("SEARCH desk");
    const agent = await storeInbound("AGENT 1");
    const [searchOut, agentOut] = await Promise.all([processInboundSms(search, { db }), processInboundSms(agent, { db })]);
    expect(searchOut[0].body).toMatch(/external agent/);
    expect(agentOut[0].body).toMatch(/Not PingMarket inventory/);
  });

  it("STOP opts the buyer out of offer updates; texting again opts back in", async () => {
    const stop = await text("STOP");
    expect(stop.replies[0].body).toMatch(/unsubscribed/);
    const [u] = await db.select().from(users).where(eq(users.id, "u_sms_buyer"));
    expect(u.consentStatus).toBe("opted_out");
    await text("HELP");
    const [again] = await db.select().from(users).where(eq(users.id, "u_sms_buyer"));
    expect(again.consentStatus).toBe("opted_in");
  });
});

describe("processInboundSms", () => {
  it("answers unknown phones without routing", async () => {
    const [row] = await db
      .insert(messages)
      .values({ id: "msg_unknown", dialEventId: "evt_unknown", fromNumber: "+15559990000", toNumber: SERVICE, body: "SEARCH desk", direction: "inbound" })
      .returning();
    const out = await processInboundSms({ ...row, createdAt: row.createdAt.toISOString() }, { db });
    expect(out.map((m) => m.body)).toEqual([NOT_REGISTERED_TEXT]);
    expect(sent).toEqual([{ to: "+15559990000", body: NOT_REGISTERED_TEXT }]);
  });
});

describe("POST /api/dial/simulate-inbound", () => {
  it("runs the inbox + processing path synchronously outside production", async () => {
    const res = await simulateInbound({ from: BUYER, body: "DETAILS D4" });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { inbound: Message; outbound: Message[] };
    expect(json.inbound).toMatchObject({ direction: "inbound", fromNumber: BUYER, toNumber: SERVICE });
    expect(json.outbound[0].body).toMatch(/^D4 Mid-century bookshelf/);
  });

  it("is a 404 for tunnel-shaped, proxied, non-local or non-JSON requests", async () => {
    const tunnel = await simulateInbound(
      { from: BUYER, body: "HELP" },
      { host: "quiet-river-1234.trycloudflare.com", "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.9" },
    );
    expect(tunnel.status).toBe(404);
    expect((await simulateInbound({ from: BUYER, body: "HELP" }, { host: "quiet-river-1234.trycloudflare.com" })).status).toBe(404);
    expect((await simulateInbound({ from: BUYER, body: "HELP" }, { "cf-connecting-ip": "203.0.113.9" })).status).toBe(404);
    expect((await simulateInbound({ from: BUYER, body: "HELP" }, { "x-forwarded-for": "203.0.113.9" })).status).toBe(404);
    expect((await simulateInbound({ from: BUYER, body: "HELP" }, { "x-forwarded-for": "203.0.113.9, ::1" })).status).toBe(404);
    expect((await simulateInbound({ from: BUYER, body: "HELP" }, { "content-type": "text/plain" })).status).toBe(404);
    expect((await simulateInbound({ from: BUYER, body: "HELP" }, { host: "127.0.0.1:3000" })).status).toBe(201);
    expect((await simulateInbound({ from: BUYER, body: "HELP" }, { host: "[::1]:3000" })).status).toBe(201);
    // Next fills in x-forwarded-for with the socket address for direct local calls.
    expect((await simulateInbound({ from: BUYER, body: "HELP" }, { "x-forwarded-for": "::1" })).status).toBe(201);
    expect(sent.filter((m) => m.body.includes("buyer commands"))).toHaveLength(3);
  });

  it("labels its inbound rows as simulated in the trace", async () => {
    const res = await simulateInbound({ from: BUYER, body: "HELP" });
    const { inbound } = (await res.json()) as { inbound: Message };
    expect(inbound.dialEventId).toMatch(/^dev_/);
    const event = (await listTraceEvents(200, db)).find((e) => e.id === `message:${inbound.id}`);
    expect(event?.summary.startsWith("SIM ")).toBe(true);
    expect(event?.detail).toMatchObject({ channel: "sim", simulated: true });
  });

  it("is a 404 in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const res = await simulateInbound({ from: BUYER, body: "HELP" });
      expect(res.status).toBe(404);
    } finally {
      vi.stubEnv("NODE_ENV", "test");
    }
  });
});
