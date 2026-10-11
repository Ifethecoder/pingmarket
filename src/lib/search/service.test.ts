import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import completedFixture from "../darwin/__fixtures__/completed.json";
import type { Db } from "../db";
import { agentSearches } from "../db/schema";
import { createTestDb } from "../db/testing";
import { runSearch } from "./service";

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
