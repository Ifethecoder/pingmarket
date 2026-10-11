import { beforeAll, describe, expect, it, vi } from "vitest";
import routeExpired from "./__fixtures__/act_route_expired.json";
import type { Db } from "../db";
import { agentSearches } from "../db/schema";
import { newUuidId } from "../db/ids";
import { createTestDb } from "../db/testing";
import {
  actRequestIdSchema,
  actStartRequestSchema,
  getDarwinAct,
  normalizeActRequest,
  startDarwinAct,
  wasReturnedBySearch,
} from "./act";
import { DarwinError } from "./client";

const KEY = "darw_test_key";

function respond(status: number, body: unknown) {
  const impl = vi.fn(
    async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
  return impl as unknown as typeof fetch & typeof impl;
}

/** Built from the documented Get Act request schema (no live reply has been observed yet). */
const replyState = {
  type: "request",
  actRequestId: "actreq_0123456789abcdef",
  searchId: null,
  status: "completed",
  createdAt: "2026-10-11T23:20:00.000Z",
  threads: [
    {
      agentId: "agent_a",
      capabilityId: "cap_a",
      threadId: "thr_1",
      state: {
        thread: "thr_1",
        messages: [
          { type: "message", message: "m1", from: "you", content: [{ type: "text", text: "desks?" }], status: "delivered", createdAt: "2026-10-11T23:20:01Z" },
          { type: "result", message: "m2", from: "agent", content: [{ type: "text", text: "Found 2 desks" }, { type: "image", assetId: "a1" }], status: "delivered", createdAt: "2026-10-11T23:20:05Z", data: { items: [{ title: "Oak desk", price: 120 }] } },
        ],
        actions: [{ action: "act_1", capability: "cap_a", request: "r0", status: "succeeded", cancellationRequested: false }],
        requests: [
          { type: "payment_request", request: "req_pay", action: "act_1", status: "pending", amountMinor: "2500", currency: "USD", payee: { agent: "agent_a", name: "Desk Shop" }, acceptedMethods: ["card"], expiresAt: "2026-10-11T23:50:00Z" },
        ],
        needsAttention: true,
      },
    },
  ],
};

describe("normalizeActRequest", () => {
  it("explains the live ROUTE_VERIFICATION_EXPIRED failure and stops polling", () => {
    const v = normalizeActRequest(routeExpired);
    expect(v.status).toBe("failed");
    expect(v.done).toBe(true);
    expect(v.threads[0].errorCode).toBe("ROUTE_VERIFICATION_EXPIRED");
    expect(v.threads[0].errorExplanation).toMatch(/re-verify/);
    expect(v.threads[0].messages).toEqual([]);
  });

  it("surfaces provider replies and never offers to answer payment requests", () => {
    const v = normalizeActRequest(replyState);
    const t = v.threads[0];
    expect(v.done).toBe(true);
    expect(t.messages.map((m) => m.from)).toEqual(["you", "agent"]);
    expect(t.messages[1].text).toBe("Found 2 desks\n[image]");
    expect(t.messages[1].data).toContain("Oak desk");
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0].summary).toBe("Provider requested payment of 25.00 USD to Desk Shop. PingMarket does not pay external agents.");
  });

  it("keeps polling while a thread is open with no reply", () => {
    const pending = { ...replyState, status: "pending", threads: [{ agentId: "a", threadId: "t", state: { messages: [], actions: [{ action: "x", status: "running", cancellationRequested: false }], requests: [] } }] };
    expect(normalizeActRequest(pending).done).toBe(false);
  });

  it("drops malformed threads instead of failing", () => {
    const v = normalizeActRequest({ ...replyState, threads: [{ nope: true }, ...replyState.threads] });
    expect(v.threads).toHaveLength(1);
  });
});

describe("Darwin Act HTTP", () => {
  it("starts one direct thread with an idempotency key and the account key", async () => {
    const fetchImpl = respond(200, routeExpired);
    const v = await startDarwinAct({ agentId: "agent_a", capabilityId: "cap_a" }, "hello", { fetchImpl, apiKey: KEY });
    expect(v.threads[0].errorCode).toBe("ROUTE_VERIFICATION_EXPIRED");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.darwin.so/api/v3/act");
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe(KEY);
    expect(headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(init.body))).toEqual({ targets: [{ agentId: "agent_a", capabilityId: "cap_a" }], message: "hello" });
  });

  it("reads thread state with includeThreadState", async () => {
    const fetchImpl = respond(200, replyState);
    await getDarwinAct("actreq_0123456789abcdef", { fetchImpl, apiKey: KEY });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.darwin.so/api/v3/act/requests/actreq_0123456789abcdef?includeThreadState=true");
  });

  it("explains Darwin's 400 codes", async () => {
    const fetchImpl = respond(400, { code: "ACT_SEARCH_AGENT_UNAVAILABLE" });
    const err = await startDarwinAct({ agentId: "a", capabilityId: "c" }, "hi", { fetchImpl, apiKey: KEY }).catch((e) => e);
    expect(err).toBeInstanceOf(DarwinError);
    expect(err.status).toBe(400);
    expect(err.details).toEqual({ code: "ACT_SEARCH_AGENT_UNAVAILABLE", explanation: expect.stringMatching(/no approved Act route/) });
  });

  it("refuses to call Darwin without an account key", async () => {
    const fetchImpl = respond(200, routeExpired);
    const prev = process.env.DARWIN_API_KEY;
    delete process.env.DARWIN_API_KEY;
    try {
      const err = await startDarwinAct({ agentId: "a", capabilityId: "c" }, "hi", { fetchImpl }).catch((e) => e);
      expect(err.code).toBe("NOT_CONFIGURED");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.DARWIN_API_KEY = prev;
    }
  });
});

describe("request validation and the search guard", () => {
  let db: Db;
  const searchId = "srch_5f37a714-328c-4b8b-9d85-0b90a7291e3c";

  beforeAll(async () => {
    db = await createTestDb();
    await db.insert(agentSearches).values({
      id: newUuidId("as"),
      query: "desk",
      darwinSearchId: searchId,
      darwinResponseId: "resp_1",
      status: "completed",
      resultMetadata: { darwin: { agents: [{ agentId: "agent_a", capabilityId: "cap_a", rank: 1 }] } },
    });
  });

  it("only allows agents Darwin returned in that stored search", async () => {
    expect(await wasReturnedBySearch(db, searchId, { agentId: "agent_a", capabilityId: "cap_a" })).toBe(true);
    expect(await wasReturnedBySearch(db, searchId, { agentId: "agent_a", capabilityId: "cap_other" })).toBe(false);
    expect(await wasReturnedBySearch(db, "srch_00000000-0000-0000-0000-000000000000", { agentId: "agent_a", capabilityId: "cap_a" })).toBe(false);
  });

  it("validates ids and message length", () => {
    expect(actStartRequestSchema.safeParse({ searchId, agentId: "agent_a", capabilityId: "cap_a", message: "  hi " }).success).toBe(true);
    expect(actStartRequestSchema.safeParse({ searchId: "nope", agentId: "a", capabilityId: "c", message: "hi" }).success).toBe(false);
    expect(actStartRequestSchema.safeParse({ searchId, agentId: "../x", capabilityId: "c", message: "hi" }).success).toBe(false);
    expect(actStartRequestSchema.safeParse({ searchId, agentId: "a", capabilityId: "c", message: "x".repeat(2001) }).success).toBe(false);
    expect(actRequestIdSchema.safeParse("actreq_c0a1e0f970df7f21b638e0295c884dc3").success).toBe(true);
    expect(actRequestIdSchema.safeParse("actreq_../../x").success).toBe(false);
  });
});
