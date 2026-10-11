import { describe, expect, it } from "vitest";
import { DARWIN_SKIPPED_OUTCOME } from "../darwin/normalize";
import type { DarwinCapabilityResult, DarwinSearchOutcome, NativeListingResult } from "../types";
import { buildSearchResponse, describeSearchForTrace } from "./merge";

function nativeListing(id: string, crossMarket: boolean): NativeListingResult {
  return {
    type: "native_listing",
    id,
    marketplaceId: crossMarket ? "furniture" : "creative",
    title: `Listing ${id}`,
    description: null,
    priceCents: 1000,
    currency: "USD",
    location: null,
    status: "available",
    crossMarket,
    matchReasons: [],
  };
}

function capability(capabilityId: string, rank: number): DarwinCapabilityResult {
  return {
    type: "darwin_capability",
    agentId: `agent-${capabilityId}`,
    agentSlug: null,
    capabilityId,
    capabilityRevision: 1,
    rank,
    name: `Capability ${capabilityId}`,
    description: null,
    readiness: "ready",
    canStartThread: false,
    canAttemptThread: false,
    providerCheck: null,
    reasons: [],
    uncertainties: [],
    requiredSetup: null,
    connectionMethods: [],
    connectionPrompt: null,
    agentPageUrl: `https://index.darwin.so/x/${capabilityId}`,
  };
}

const completed: DarwinSearchOutcome = {
  status: "completed",
  searchId: "s1",
  responseId: "r1",
  previousResponseId: null,
  relatedSearches: [],
  question: null,
  noMatchReason: null,
  overview: "overview",
  assessment: { outcome: "match", explanation: "x" },
  error: null,
  latencyMs: 812,
};

describe("buildSearchResponse", () => {
  it("keeps native order, sorts capabilities by rank and passes darwin through", () => {
    const native = [nativeListing("D1", true), nativeListing("D6", false)];
    const caps = [capability("c3", 3), capability("c1", 1), capability("c2", 2)];
    const resp = buildSearchResponse(
      { query: "q", marketplaceId: "creative" },
      native,
      { outcome: completed, capabilities: caps },
    );
    expect(resp.query).toBe("q");
    expect(resp.marketplaceId).toBe("creative");
    expect(resp.nativeListings.map((l) => l.id)).toEqual(["D1", "D6"]);
    expect(resp.externalCapabilities.map((c) => c.capabilityId)).toEqual(["c1", "c2", "c3"]);
    expect(resp.darwin).toBe(completed);
    expect(caps.map((c) => c.rank)).toEqual([3, 1, 2]); // input not mutated
    expect(Object.keys(resp).sort()).toEqual(
      ["darwin", "externalCapabilities", "marketplaceId", "nativeListings", "query"],
    );
  });

  it("defaults marketplaceId to null", () => {
    const resp = buildSearchResponse({ query: "q" }, [], {
      outcome: DARWIN_SKIPPED_OUTCOME,
      capabilities: [],
    });
    expect(resp.marketplaceId).toBeNull();
    expect(resp.darwin.status).toBe("skipped");
  });
});

describe("describeSearchForTrace", () => {
  const native = [nativeListing("D1", true), nativeListing("D6", false)];

  it("summarizes completed searches", () => {
    const resp = buildSearchResponse({ query: "q" }, native, {
      outcome: completed,
      capabilities: [capability("a", 1), capability("b", 2), capability("c", 3)],
    });
    expect(describeSearchForTrace(resp)).toBe("2 native (1 cross-market) · Darwin completed: 3 capabilities");
  });

  it("summarizes needs_input, error and skipped", () => {
    const base = { query: "q" };
    expect(
      describeSearchForTrace(
        buildSearchResponse(base, [], {
          outcome: { ...completed, status: "needs_input", question: "Which city?" },
          capabilities: [],
        }),
      ),
    ).toBe("0 native · Darwin needs_input");
    expect(
      describeSearchForTrace(
        buildSearchResponse(base, [nativeListing("D6", false)], {
          outcome: { ...completed, status: "error", error: "Darwin HTTP 503" },
          capabilities: [],
        }),
      ),
    ).toBe("1 native · Darwin error: Darwin HTTP 503");
    expect(
      describeSearchForTrace(
        buildSearchResponse(base, [], { outcome: DARWIN_SKIPPED_OUTCOME, capabilities: [] }),
      ),
    ).toBe("0 native · Darwin skipped");
  });
});
