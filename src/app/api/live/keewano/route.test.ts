import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: vi.fn(),
  ingestEnabled: vi.fn(),
  queryConfigured: vi.fn(),
  query: vi.fn(),
}));

vi.mock("next/server", () => ({
  connection: mocks.connection,
  NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
}));
vi.mock("@/lib/keewano/ingest", () => ({ isKeewanoIngestEnabled: mocks.ingestEnabled }));
vi.mock("@/lib/keewano/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/keewano/query")>()),
  isKeewanoQueryConfigured: mocks.queryConfigured,
  keewanoQuery: mocks.query,
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ingestEnabled.mockReturnValue(false);
  mocks.queryConfigured.mockReturnValue(false);
});

describe("live Keewano status", () => {
  it("reports missing configuration without attempting a query", async () => {
    const response = await GET();
    expect(await response.json()).toEqual({
      ingestionConfigured: false,
      queryConfigured: false,
      status: "not_configured",
      entities: null,
      events: null,
      counterBands: [],
      queriedAt: null,
    });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.connection).toHaveBeenCalledOnce();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reads live totals and counter outcomes and normalizes numeric strings", async () => {
    mocks.ingestEnabled.mockReturnValue(true);
    mocks.queryConfigured.mockReturnValue(true);
    mocks.query.mockResolvedValueOnce([{ entities: "8", events: "42" }]);
    mocks.query.mockResolvedValueOnce([{ marketplace: "furniture", band: "90-99", accepted: "5", declined: "3" }]);
    const body = await (await GET()).json();
    expect(body).toMatchObject({
      ingestionConfigured: true,
      queryConfigured: true,
      status: "connected",
      entities: 8,
      events: 42,
      counterBands: [{ marketplace: "furniture", band: "90-99", accepted: 5, declined: 3 }],
    });
    expect(body.queriedAt).toEqual(expect.any(String));
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[0][0]).toBe("SELECT count(DISTINCT user_id) AS entities, count(*) AS events FROM events");
  });

  it("returns a safe error without database messages or credentials", async () => {
    mocks.queryConfigured.mockReturnValue(true);
    mocks.query.mockRejectedValue(new Error("password kwpat-secret failed SELECT private SQL"));
    const body = await (await GET()).json();
    expect(body.status).toBe("error");
    expect(body.entities).toBeNull();
    expect(body.counterBands).toEqual([]);
    expect(body.queriedAt).toBeNull();
    expect(body.error).toBe("Keewano is unavailable. Try refreshing in a moment.");
    expect(JSON.stringify(body)).not.toContain("kwpat-secret");
  });
});
