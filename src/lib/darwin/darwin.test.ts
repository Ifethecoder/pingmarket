import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import completedFixture from "./__fixtures__/completed.json";
import needsInputFixture from "./__fixtures__/needs_input.json";
import { DARWIN_SEARCH_URL, DarwinError, darwinSearchRaw } from "./client";
import { DARWIN_SKIPPED_OUTCOME, darwinErrorOutcome, normalizeDarwinAgent, normalizeDarwinResponse } from "./normalize";
import { runDarwinDiscovery, summarizeForPersistence } from "./search";

const SECRET_TOKEN = "stok_SECRET_DO_NOT_LEAK_123";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Call = { url: string; init: RequestInit };

/** Stub fetch that returns queued responses in order and records calls. */
function stubFetch(...responses: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return next();
  });
  return { fetchImpl: impl as unknown as typeof fetch, calls, impl };
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function headersOf(call: Call): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

beforeEach(() => {
  vi.stubEnv("DARWIN_API_KEY", "");
  vi.stubEnv("DARWIN_SEARCH_MAX_RESULTS", "");
  vi.stubEnv("DARWIN_SEARCH_TIMEOUT_MS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("darwinSearchRaw request", () => {
  it("sends only defined keys and no api key when none is configured", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(completedFixture));
    await darwinSearchRaw("oak desk", { fetchImpl, maxResults: 5 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(DARWIN_SEARCH_URL);
    expect(calls[0].init.method).toBe("POST");
    expect(bodyOf(calls[0])).toStrictEqual({ query: "oak desk", maxResults: 5 });
    expect(String(calls[0].init.body)).not.toContain("undefined");
    expect(headersOf(calls[0])["Content-Type"]).toBe("application/json");
    expect(headersOf(calls[0])).not.toHaveProperty("x-api-key");
  });

  it("sends x-api-key from options or env", async () => {
    const a = stubFetch(() => jsonResponse(completedFixture));
    await darwinSearchRaw("q", { fetchImpl: a.fetchImpl, apiKey: "key_opt" });
    expect(headersOf(a.calls[0])["x-api-key"]).toBe("key_opt");

    vi.stubEnv("DARWIN_API_KEY", "key_env");
    const b = stubFetch(() => jsonResponse(completedFixture));
    await darwinSearchRaw("q", { fetchImpl: b.fetchImpl });
    expect(headersOf(b.calls[0])["x-api-key"]).toBe("key_env");

    const c = stubFetch(() => jsonResponse(completedFixture));
    await darwinSearchRaw("q", { fetchImpl: c.fetchImpl, apiKey: null });
    expect(headersOf(c.calls[0])).not.toHaveProperty("x-api-key");
  });

  it("runDarwinDiscovery builds query, budget/location context and default maxResults", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(completedFixture));
    await runDarwinDiscovery("custom wall art", {
      fetchImpl,
      maxPriceCents: 15000,
      location: " Berkeley ",
      marketplaceId: "creative",
    });
    expect(bodyOf(calls[0])).toStrictEqual({
      query: "custom wall art (buyer browsing the Creative marketplace; looking for a seller/provider agent)",
      maxResults: 5,
      context: [
        { type: "budget", amountMinor: 15000, currency: "USD" },
        { type: "text", text: "Location: Berkeley" },
      ],
    });
  });

  it("runDarwinDiscovery omits context when not given and clamps maxResults", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(completedFixture));
    await runDarwinDiscovery("q", { fetchImpl, maxResults: 99 });
    expect(bodyOf(calls[0])).toStrictEqual({ query: "q", maxResults: 20 });

    vi.stubEnv("DARWIN_SEARCH_MAX_RESULTS", "3");
    const b = stubFetch(() => jsonResponse(completedFixture));
    await runDarwinDiscovery("q", { fetchImpl: b.fetchImpl });
    expect(bodyOf(b.calls[0])).toStrictEqual({ query: "q", maxResults: 3 });
  });
});

describe("normalization of real fixtures", () => {
  it("completed fixture → two ranked capabilities with verbatim ids", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(completedFixture));
    const { outcome, capabilities } = await runDarwinDiscovery("MCP tool to audit a website", { fetchImpl });

    expect(outcome.status).toBe("completed");
    expect(outcome.searchId).toBe("srch_876f369c-0cca-44de-8595-87e555ec78e3");
    expect(outcome.responseId).toBe("sresp_098d7e49-8de3-450f-a1ea-afa786bbc7dc");
    expect(outcome.assessment?.outcome).toBe("partial");
    expect(outcome.error).toBeNull();
    expect(typeof outcome.latencyMs).toBe("number");

    expect(capabilities.map((c) => c.rank)).toEqual([1, 2]);
    const [first, second] = capabilities;
    expect(first).toMatchObject({
      type: "darwin_capability",
      agentId: "cmuzpz2ds004r06mwsgnsryjd",
      agentSlug: "cmuzpz2ds004r06mwsgnsryjd",
      capabilityId: "cmuzq1zct005006styoqlq0us",
      capabilityRevision: 1791568898009,
      name: "Scan a website for accessibility issues",
      readiness: "unavailable",
      canStartThread: false,
      canAttemptThread: false,
      providerCheck: "not_attempted",
      requiredSetup: null,
      connectionMethods: [],
      uncertainties: ["Execution requires a fresh readiness check."],
      agentPageUrl: "https://index.darwin.so/agent/cmuzpz2ds004r06mwsgnsryjd?capability=cmuzq1zct005006styoqlq0us",
    });
    expect(first.reasons).toHaveLength(1);
    expect(first.connectionPrompt).toContain("Darwin Act is a pilot preview");
    expect(second).toMatchObject({
      agentId: "cmudrkx4d02c30bgmkedhmi1s",
      capabilityId: "cmudrnrrn00la0agms8pgvetv",
      capabilityRevision: 1791573806609,
      readiness: "unavailable",
      connectionMethods: [],
      agentPageUrl: "https://index.darwin.so/agent/cmudrkx4d02c30bgmkedhmi1s?capability=cmudrnrrn00la0agms8pgvetv",
    });
  });

  it("sorts by rank even when Darwin returns them out of order", async () => {
    const shuffled = structuredClone(completedFixture);
    shuffled.response.agents.reverse();
    const { fetchImpl } = stubFetch(() => jsonResponse(shuffled));
    const { capabilities } = await runDarwinDiscovery("q", { fetchImpl });
    expect(capabilities.map((c) => c.rank)).toEqual([1, 2]);
  });

  it("completed with zero agents is reported as no_match, never as an empty success", async () => {
    const empty = structuredClone(completedFixture);
    empty.response.agents = [];
    const raw = await darwinSearchRaw("q", { fetchImpl: stubFetch(() => jsonResponse(empty)).fetchImpl });
    const { outcome, capabilities } = normalizeDarwinResponse(raw, 1);
    expect(outcome.status).toBe("no_match");
    expect(outcome.noMatchReason).toBeTruthy();
    expect(capabilities).toEqual([]);
  });

  it("needs_input fixture → question surfaced, no capabilities", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(needsInputFixture));
    const { outcome, capabilities } = await runDarwinDiscovery("cheap stuff", { fetchImpl });
    expect(outcome.status).toBe("needs_input");
    expect(outcome.question).toBe(needsInputFixture.response.question);
    expect(outcome.question).toMatch(/general sales or pricing/);
    expect(outcome.assessment).toEqual({
      outcome: "clarify",
      explanation: needsInputFixture.response.assessment.explanation,
    });
    expect(capabilities).toEqual([]);
  });

  it("no_match surfaces noMatchReason", async () => {
    const noMatch = {
      ...needsInputFixture,
      status: "no_match",
      response: { ...needsInputFixture.response, question: null, noMatchReason: "No indexed agent sells desks." },
    };
    const { fetchImpl } = stubFetch(() => jsonResponse(noMatch));
    const { outcome, capabilities } = await runDarwinDiscovery("desk", { fetchImpl });
    expect(outcome.status).toBe("no_match");
    expect(outcome.noMatchReason).toBe("No indexed agent sells desks.");
    expect(capabilities).toEqual([]);
  });

  it("unknown readiness → recheck_required with an uncertainty note", () => {
    const agent = { ...completedFixture.response.agents[0], readiness: "warming_up" };
    const cap = normalizeDarwinAgent(agent as never);
    expect(cap.readiness).toBe("recheck_required");
    expect(cap.uncertainties).toContain("Readiness value 'warming_up' not recognized");
  });

  it("tolerates unknown future fields", async () => {
    const extended = structuredClone(completedFixture) as Record<string, unknown>;
    extended.newTopLevelField = { x: 1 };
    const { fetchImpl } = stubFetch(() => jsonResponse(extended));
    const { outcome, capabilities } = await runDarwinDiscovery("q", { fetchImpl });
    expect(outcome.status).toBe("completed");
    expect(capabilities).toHaveLength(2);
  });
});

describe("errors and retries", () => {
  it("retries once on 500 then succeeds", async () => {
    const { fetchImpl, calls } = stubFetch(
      () => jsonResponse({ statusCode: 500, message: "Internal server error" }, 500),
      () => jsonResponse(completedFixture),
    );
    const raw = await darwinSearchRaw("q", { fetchImpl });
    expect(calls).toHaveLength(2);
    expect(raw.status).toBe("completed");
  });

  it("fails after a second 5xx", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({ statusCode: 503, message: "down" }, 503));
    await expect(darwinSearchRaw("q", { fetchImpl })).rejects.toMatchObject({ code: "HTTP_ERROR", status: 503 });
    expect(calls).toHaveLength(2);
  });

  it("retries once on network error", async () => {
    const { fetchImpl, calls } = stubFetch(
      () => {
        throw new TypeError("fetch failed");
      },
      () => jsonResponse(completedFixture),
    );
    const raw = await darwinSearchRaw("q", { fetchImpl });
    expect(calls).toHaveLength(2);
    expect(raw.status).toBe("completed");
  });

  it("429 → RATE_LIMITED without retry; runDarwinDiscovery returns error outcome", async () => {
    const a = stubFetch(() => jsonResponse({ code: "RATE_LIMITED", message: "slow down" }, 429));
    const err = await darwinSearchRaw("q", { fetchImpl: a.fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DarwinError);
    expect(err).toMatchObject({ code: "RATE_LIMITED", status: 429 });
    expect(a.calls).toHaveLength(1);

    const b = stubFetch(() => jsonResponse({ code: "RATE_LIMITED", message: "slow down" }, 429));
    const result = await runDarwinDiscovery("q", { fetchImpl: b.fetchImpl });
    expect(b.calls).toHaveLength(1);
    expect(result.outcome.status).toBe("error");
    expect(result.outcome.error).toMatch(/rate-limited/);
    expect(result.capabilities).toEqual([]);
    expect(result.raw).toBeUndefined();
  });

  it("400 → HTTP_ERROR without retry", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ code: "SEARCH_REQUEST_INVALID", message: "bad" }, 400),
    );
    await expect(darwinSearchRaw("q", { fetchImpl })).rejects.toMatchObject({ code: "HTTP_ERROR", status: 400 });
    expect(calls).toHaveLength(1);
  });

  it("timeout → TIMEOUT error and runDarwinDiscovery status error", async () => {
    const hang = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof fetch;

    await expect(darwinSearchRaw("q", { fetchImpl: hang, timeoutMs: 30 })).rejects.toMatchObject({
      code: "TIMEOUT",
    });

    vi.stubEnv("DARWIN_SEARCH_TIMEOUT_MS", "30");
    const result = await runDarwinDiscovery("q", { fetchImpl: hang });
    expect(result.outcome.status).toBe("error");
    expect(result.outcome.error).toBe("Darwin Search timed out.");
    expect(result.capabilities).toEqual([]);
  });

  it("invalid 200 body → INVALID_RESPONSE", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ hello: "world" }));
    await expect(darwinSearchRaw("q", { fetchImpl })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("darwinErrorOutcome is UI-safe and skipped outcome is inert", () => {
    const outcome = darwinErrorOutcome(new Error("secret internals key=abc"), 12);
    expect(outcome).toMatchObject({ status: "error", latencyMs: 12, error: "Darwin Search failed unexpectedly." });
    expect(DARWIN_SKIPPED_OUTCOME.status).toBe("skipped");
    expect(DARWIN_SKIPPED_OUTCOME.error).toBeNull();
  });
});

describe("searchToken privacy", () => {
  it("never appears in outcome, capabilities, raw or persistence summary", async () => {
    const withToken = { ...completedFixture, searchToken: SECRET_TOKEN };
    const { fetchImpl } = stubFetch(() => jsonResponse(withToken));
    const result = await runDarwinDiscovery("q", { fetchImpl });

    expect(result.raw).toBeDefined();
    const summary = summarizeForPersistence(result.raw!);
    for (const value of [result.outcome, result.capabilities, result.raw, summary, result]) {
      expect(JSON.stringify(value)).not.toContain(SECRET_TOKEN);
      expect(JSON.stringify(value)).not.toContain("searchToken");
    }

    expect(summary).toStrictEqual({
      status: "completed",
      assessment: { outcome: "partial", explanation: completedFixture.response.assessment.explanation },
      agentCount: 2,
      agents: [
        {
          agentId: "cmuzpz2ds004r06mwsgnsryjd",
          capabilityId: "cmuzq1zct005006styoqlq0us",
          capabilityRevision: 1791568898009,
          rank: 1,
          name: "Scan a website for accessibility issues",
          readiness: "unavailable",
        },
        {
          agentId: "cmudrkx4d02c30bgmkedhmi1s",
          capabilityId: "cmudrnrrn00la0agms8pgvetv",
          capabilityRevision: 1791573806609,
          rank: 2,
          name: "accessibility_audit",
          readiness: "unavailable",
        },
      ],
      question: null,
      noMatchReason: null,
    });
    expect(JSON.stringify(summary)).not.toContain("connectionPrompt");
  });
});
