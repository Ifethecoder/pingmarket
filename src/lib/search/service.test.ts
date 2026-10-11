import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import completedFixture from "../darwin/__fixtures__/completed.json";
import followUpFixture from "../darwin/__fixtures__/followup_no_match.json";
import type { Db } from "../db";
import { agentSearches } from "../db/schema";
import { createTestDb } from "../db/testing";
import { listTraceEvents } from "../events/service";
import { runSearch, SearchError } from "./service";

const SECRET_TOKEN = "stok_SERVICE_SECRET_456";

function jsonFetch(...bodies: unknown[]) {
  let i = 0;
  const impl = vi.fn(
    async () =>
      new Response(JSON.stringify(bodies[Math.min(i++, bodies.length - 1)]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  return impl as unknown as typeof fetch & typeof impl;
}

const DEMO_QUERY = "desk under $150 in Berkeley; also interested in custom wall art";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});

describe("runSearch", () => {
  it("merges native + Darwin results and persists one agent_searches row", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(completedFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const resp = await runSearch(
      { query: DEMO_QUERY, marketplaceId: "creative" },
      { db, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toContain("15000"); // parsed budget forwarded as Darwin context

    expect(resp.marketplaceId).toBe("creative");
    expect(resp.nativeListings.map((l) => l.id)).toEqual(expect.arrayContaining(["D1", "D6"]));
    expect(resp.darwin.status).toBe("completed");
    expect(resp.darwin.searchId).toBe(completedFixture.searchId);
    expect(resp.externalCapabilities.length).toBeGreaterThan(0);
    const ranks = resp.externalCapabilities.map((c) => c.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));

    const [row] = await db
      .select()
      .from(agentSearches)
      .where(eq(agentSearches.darwinSearchId, completedFixture.searchId));
    expect(row).toMatchObject({
      query: DEMO_QUERY,
      status: "completed",
      darwinResponseId: completedFixture.responseId,
    });
    expect(row.id).toMatch(/^as_/);
    expect(row.resultMetadata).toMatchObject({
      marketplaceId: "creative",
      nativeCount: resp.nativeListings.length,
      nativeIds: resp.nativeListings.map((l) => l.id),
      darwin: { status: "completed" },
    });
  });

  it("stores the Darwin searchToken server-side only, then uses it for a follow-up and carries it forward", async () => {
    // Turn 1: first response carries the private token. Unique ids: the first test inserts the fixture ids too.
    const first = {
      ...completedFixture,
      searchId: "srch_11111111-1111-4111-8111-111111111111",
      responseId: "sresp_11111111-1111-4111-8111-111111111111",
      searchToken: SECRET_TOKEN,
    };
    const fetch1 = jsonFetch(first);
    const resp1 = await runSearch({ query: "scan my site for accessibility", marketplaceId: "creative" }, { db, fetchImpl: fetch1 });
    expect(JSON.stringify(resp1)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(resp1)).not.toContain("searchToken");
    expect(resp1.darwin.previousResponseId).toBeNull();
    expect(resp1.darwin.relatedSearches).toEqual([]);

    const [row1] = await db.select().from(agentSearches).where(eq(agentSearches.darwinResponseId, resp1.darwin.responseId!));
    expect(row1.darwinSearchToken).toBe(SECRET_TOKEN);
    expect(JSON.stringify(row1.resultMetadata)).not.toContain(SECRET_TOKEN);

    // Turn 2: follow-up. Darwin's real follow-up responses carry no new token.
    const followUp = { ...followUpFixture, previousResponseId: resp1.darwin.responseId! };
    const fetch2 = jsonFetch(followUp);
    const resp2 = await runSearch(
      { query: "only ones with a PDF report", marketplaceId: "creative", previousResponseId: resp1.darwin.responseId! },
      { db, fetchImpl: fetch2 },
    );
    const [, init] = fetch2.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(headers["X-Search-Token"]).toBe(SECRET_TOKEN);
    expect(body.previousResponseId).toBe(resp1.darwin.responseId);
    expect(body.query).toBe("only ones with a PDF report"); // verbatim: no marketplace suffix on follow-ups

    expect(resp2.darwin.status).toBe("no_match");
    expect(resp2.darwin.previousResponseId).toBe(resp1.darwin.responseId);
    expect(resp2.darwin.responseId).toBe(followUpFixture.responseId);
    expect(JSON.stringify(resp2)).not.toContain(SECRET_TOKEN);

    const [row2] = await db.select().from(agentSearches).where(eq(agentSearches.darwinResponseId, followUpFixture.responseId));
    expect(row2.darwinSearchToken).toBe(SECRET_TOKEN); // carried forward so turn 3 can continue
    expect(row2.resultMetadata).toMatchObject({ previousResponseId: resp1.darwin.responseId });

    // Turn 3 continues from turn 2's responseId using the carried token.
    const fetch3 = jsonFetch({ ...followUpFixture, responseId: "sresp_33333333-3333-4333-8333-333333333333", previousResponseId: followUpFixture.responseId });
    await runSearch({ query: "third turn", previousResponseId: followUpFixture.responseId }, { db, fetchImpl: fetch3 });
    const [, init3] = fetch3.mock.calls[0] as unknown as [string, RequestInit];
    expect((init3.headers as Record<string, string>)["X-Search-Token"]).toBe(SECRET_TOKEN);

    // The trace feed labels follow-ups and never leaks the token.
    const events = await listTraceEvents(50, db);
    const traceJson = JSON.stringify(events);
    expect(traceJson).not.toContain(SECRET_TOKEN);
    expect(traceJson).not.toContain("darwinSearchToken");
    expect(events.find((e) => e.detail?.darwinResponseId === followUpFixture.responseId)?.summary).toMatch(/^Follow-up "only ones/);
    expect(events.find((e) => e.detail?.darwinResponseId === resp1.darwin.responseId)?.summary).toMatch(/^Search "scan my site/);
  });

  it("rejects an unknown previousResponseId before calling Darwin", async () => {
    const fetchImpl = vi.fn();
    await expect(
      runSearch({ query: "q", previousResponseId: "sresp_00000000-0000-4000-8000-000000000000" }, { db, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(SearchError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips Darwin when includeExternalAgents is false", async () => {
    const fetchImpl = vi.fn();
    const resp = await runSearch(
      { query: "poster", includeExternalAgents: false },
      { db, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resp.darwin.status).toBe("skipped");
    expect(resp.externalCapabilities).toEqual([]);
    expect(resp.marketplaceId).toBeNull();
    const rows = await db.select().from(agentSearches).where(eq(agentSearches.status, "skipped"));
    expect(rows).toHaveLength(1);
    expect(rows[0].resultMetadata).toMatchObject({ darwin: { status: "skipped" }, nativeCount: resp.nativeListings.length });
  });
});
