/**
 * Live acceptance test for Darwin discovery against a running PingMarket dev server.
 *
 * Covers PRD §6 PM-06 (live Darwin Search returns real agents or a truthful no-match),
 * PM-07 (native vs external results are labeled, no fabricated inventory/quotes/IDs),
 * and the Developer B acceptance test (Journey B query → cross-market native match +
 * live Darwin outcome → offer created through the shared API).
 *
 * Usage:
 *   npm run dev                        # in another terminal
 *   npm run darwin:acceptance          # or: npx tsx scripts/darwin-acceptance.ts
 *
 * Env:
 *   PINGMARKET_URL   base URL (default http://localhost:3000)
 *   SKIP_OFFER=1     don't POST /api/offers at the end (it writes one open offer to the local DB)
 *
 * Makes 5 live Darwin calls sequentially (anonymous rate limit). Exit code 1 on any failure.
 */
import type { DarwinReadiness, SearchRequest, SearchResponse } from "../src/lib/types";

const BASE = (process.env.PINGMARKET_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SKIP_OFFER = process.env.SKIP_OFFER === "1";

const READINESS: readonly DarwinReadiness[] = ["ready", "authentication_required", "recheck_required", "unavailable"];
const LIVE_STATUSES = ["completed", "no_match", "needs_input"] as const;

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------

type Result = { name: string; ok: boolean; info: string };
const results: Result[] = [];

function check(name: string, ok: boolean, info = ""): boolean {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  — ${info}` : ""}`);
  return ok;
}

async function search(body: SearchRequest): Promise<{ res: SearchResponse; rawText: string; ms: number }> {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const rawText = await r.text();
  if (!r.ok) throw new Error(`POST /api/search → HTTP ${r.status}: ${rawText.slice(0, 300)}`);
  return { res: JSON.parse(rawText) as SearchResponse, rawText, ms: Date.now() - t0 };
}

function fmtDarwin(res: SearchResponse): string {
  const d = res.darwin;
  return `darwin=${d.status} caps=${res.externalCapabilities.length} native=${res.nativeListings.length} ${d.latencyMs ?? "-"}ms`;
}

/** Shared PM-06 / PM-07 invariants for any response where Darwin was actually called. */
function checkLiveInvariants(label: string, res: SearchResponse, rawText: string) {
  const d = res.darwin;

  check(`${label}: Darwin was called and returned a live outcome`, (LIVE_STATUSES as readonly string[]).includes(d.status),
    `status=${d.status}${d.error ? ` error="${d.error}"` : ""}`);
  check(`${label}: latencyMs is a real measurement`, typeof d.latencyMs === "number" && d.latencyMs > 0, `${d.latencyMs}ms`);
  check(`${label}: private searchToken never reaches the client`, !rawText.includes("searchToken"));

  // PM-07: labeling
  check(`${label}: every native result is typed native_listing`, res.nativeListings.every((n) => n.type === "native_listing"));
  check(`${label}: every external result is typed darwin_capability`, res.externalCapabilities.every((c) => c.type === "darwin_capability"));

  if (d.status === "completed") {
    check(`${label}: completed ⇒ at least one capability (never an empty "success")`, res.externalCapabilities.length > 0);
  }
  if (d.status !== "no_match") {
    check(`${label}: searchId/responseId are Darwin's`, !!d.searchId?.startsWith("srch_") && !!d.responseId?.startsWith("sresp_"),
      `${d.searchId} / ${d.responseId}`);
  }
  if (res.externalCapabilities.length > 0) {
    for (const c of res.externalCapabilities) {
      const tag = `${label}: cap#${c.rank} "${c.name.slice(0, 40)}"`;
      check(`${tag} has verbatim Darwin ids`, c.agentId.length > 0 && c.capabilityId.length > 0, `${c.agentId} / ${c.capabilityId}`);
      check(`${tag} agentPageUrl is built from those exact ids`,
        c.agentPageUrl.includes(encodeURIComponent(c.agentId)) && c.agentPageUrl.includes(encodeURIComponent(c.capabilityId)));
      check(`${tag} readiness is a known value`, READINESS.includes(c.readiness), c.readiness);
      check(`${tag} readiness/thread flags are consistent`, c.readiness === "ready" || !c.canStartThread,
        `readiness=${c.readiness} canStartThread=${c.canStartThread}`);
      // PM-07: no fabricated inventory/quotes. A capability must not carry listing-like fields.
      const forbidden = ["priceCents", "price", "quote", "inventory", "status", "crossMarket"].filter((k) => k in c);
      check(`${tag} carries no price/quote/inventory fields`, forbidden.length === 0, forbidden.join(","));
    }
  }
  if (d.status === "no_match") {
    check(`${label}: no_match ⇒ zero capabilities`, res.externalCapabilities.length === 0);
    check(`${label}: no_match ⇒ reason is stated`, typeof d.noMatchReason === "string" && d.noMatchReason.length > 0, d.noMatchReason ?? "");
  }
  if (d.status === "needs_input") {
    check(`${label}: needs_input ⇒ question is stated`, typeof d.question === "string" && d.question.length > 0, d.question ?? "");
  }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function main() {
  console.log(`PingMarket Darwin acceptance — ${BASE}\n`);

  // Preflight: server up and seeded.
  const mk = await fetch(`${BASE}/api/marketplaces`).then((r) => r.json() as Promise<{ marketplaces: { id: string }[] }>);
  const ids = mk.marketplaces.map((m) => m.id);
  check("preflight: dev server up with seeded marketplaces", ids.includes("furniture") && ids.includes("creative"), ids.join(","));

  // ---- Case A: the PRD Journey B buyer query (Dev B acceptance test) -----------------------
  console.log("\n[A] Journey B — PRD §5 buyer query, searched from the creative marketplace");
  const A = await search({
    query: "Looking for a desk under $150 in Berkeley; also interested in custom wall art",
    marketplaceId: "creative",
    includeExternalAgents: true,
  });
  console.log(`    ${fmtDarwin(A.res)} (route ${A.ms}ms)`);
  if (A.res.darwin.overview) console.log(`    overview: ${A.res.darwin.overview}`);

  const oak = A.res.nativeListings.find((n) => n.id === "D1");
  check("A: native cross-market match — seeded Oak desk (furniture, $120, Berkeley) found from creative",
    !!oak && oak.marketplaceId === "furniture" && oak.crossMarket === true,
    oak ? `${oak.title} $${oak.priceCents / 100} crossMarket=${oak.crossMarket} [${oak.matchReasons.join("; ")}]` : "not found");
  check("A: no native result over the $150 budget", A.res.nativeListings.every((n) => n.priceCents <= 15000),
    A.res.nativeListings.map((n) => `${n.id}:$${n.priceCents / 100}`).join(" "));
  checkLiveInvariants("A", A.res, A.rawText);

  // ---- Case B: control query that Darwin's index is known to match -------------------------
  // If A came back no_match (Darwin indexes agents, not goods), this proves the pipe still
  // carries real agents end to end, so a no_match in A is truthful rather than a broken adapter.
  console.log("\n[B] Control — agent-shaped query Darwin's index should match");
  const B = await search({ query: "translate a PDF document from English to Japanese", marketplaceId: "furniture" });
  console.log(`    ${fmtDarwin(B.res)} (route ${B.ms}ms)`);
  // Darwin is non-deterministic for the same query: it may answer `completed` or `needs_input`
  // (asking for the PDF URL) and attach the candidate agent either way. Both prove the pipe works.
  check("B: Darwin returned real agent capabilities (completed or needs_input)",
    (B.res.darwin.status === "completed" || B.res.darwin.status === "needs_input") && B.res.externalCapabilities.length > 0,
    `${B.res.darwin.status}: ${B.res.externalCapabilities.map((c) => `#${c.rank} ${c.name} [${c.readiness}]`).join(" | ") || "no capabilities"}`);
  checkLiveInvariants("B", B.res, B.rawText);

  // ---- Case B2: follow-up on B (Darwin Search v3 previousResponseId) ----------------------
  console.log("\n[B2] Follow-up — continue case B's Darwin search via previousResponseId");
  const prev = B.res.darwin.responseId;
  if (!prev) {
    check("B2: case B produced a responseId to follow up on", false, `status=${B.res.darwin.status}`);
  } else {
    const B2 = await search({
      query: "translate the PDF at https://example.com/paper.pdf from English to Japanese, keeping the layout",
      marketplaceId: "furniture",
      previousResponseId: prev,
    });
    console.log(`    ${fmtDarwin(B2.res)} (route ${B2.ms}ms)`);
    check("B2: follow-up accepted by Darwin (live outcome, not error)", (LIVE_STATUSES as readonly string[]).includes(B2.res.darwin.status),
      `status=${B2.res.darwin.status}${B2.res.darwin.error ? ` error="${B2.res.darwin.error}"` : ""}`);
    check("B2: response continues the same Darwin search", B2.res.darwin.searchId === B.res.darwin.searchId,
      `${B2.res.darwin.searchId} vs ${B.res.darwin.searchId}`);
    check("B2: previousResponseId echoed, new responseId issued",
      B2.res.darwin.previousResponseId === prev && !!B2.res.darwin.responseId && B2.res.darwin.responseId !== prev,
      `${prev} → ${B2.res.darwin.responseId}`);
    check("B2: a second follow-up can continue from the new responseId (token carried forward)", await (async () => {
      if (!B2.res.darwin.responseId) return false;
      const B3 = await search({ query: "same task, but only providers that return a bilingual side-by-side PDF", previousResponseId: B2.res.darwin.responseId });
      console.log(`    turn 3: ${fmtDarwin(B3.res)}`);
      return (LIVE_STATUSES as readonly string[]).includes(B3.res.darwin.status) && B3.res.darwin.previousResponseId === B2.res.darwin.responseId;
    })());
    checkLiveInvariants("B2", B2.res, B2.rawText);
  }

  // Unknown previousResponseId must be a 400 from PingMarket, before any Darwin call.
  {
    const r = await fetch(`${BASE}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "q", previousResponseId: "sresp_00000000-0000-4000-8000-000000000000" }),
    });
    const body = (await r.json()) as { error?: string; code?: string };
    check("B2: unknown previousResponseId → 400 UNKNOWN_PREVIOUS_RESPONSE", r.status === 400 && body.code === "UNKNOWN_PREVIOUS_RESPONSE",
      `HTTP ${r.status} ${body.code ?? body.error ?? ""}`);
  }

  // ---- Case C: truthful no-match ---------------------------------------------------------
  console.log("\n[C] Truthful no-match — nonsense query");
  const C = await search({ query: "xqzv wumbo flarndale 9183 purple unicorn saddle", marketplaceId: "furniture" });
  console.log(`    ${fmtDarwin(C.res)} (route ${C.ms}ms)`);
  check("C: nonsense query ⇒ no_match (not an invented agent, not an error)", C.res.darwin.status === "no_match",
    `status=${C.res.darwin.status}`);
  check("C: no native listings either", C.res.nativeListings.length === 0);
  checkLiveInvariants("C", C.res, C.rawText);

  // ---- Case D: kill switch ---------------------------------------------------------------
  console.log("\n[D] includeExternalAgents=false — Darwin must not be called");
  const D = await search({ query: "oak desk", marketplaceId: "furniture", includeExternalAgents: false });
  console.log(`    ${fmtDarwin(D.res)} (route ${D.ms}ms)`);
  check("D: status=skipped, no latency, no capabilities",
    D.res.darwin.status === "skipped" && D.res.darwin.latencyMs === null && D.res.externalCapabilities.length === 0);
  check("D: native search still works on its own", D.res.nativeListings.some((n) => n.id === "D1"));
  check("D: skipped search is fast (no network wait)", D.ms < 2000, `${D.ms}ms`);

  // ---- Case E: event trace (PM-09) --------------------------------------------------------
  console.log("\n[E] Event trace records the Darwin search with Darwin's own ids");
  type TraceEvent = { kind: string; summary: string; detail: Record<string, unknown> };
  const ev = await fetch(`${BASE}/api/events?limit=20`).then((r) => r.json() as Promise<{ events: TraceEvent[] }>);
  const evA = ev.events.find((e) => e.kind === "darwin_search" && e.detail.darwinSearchId === A.res.darwin.searchId);
  const evB = ev.events.find((e) => e.kind === "darwin_search" && e.detail.darwinSearchId === B.res.darwin.searchId);
  check("E: case A search appears in trace with its darwinSearchId", !!evA || A.res.darwin.searchId === null, evA?.summary ?? "");
  check("E: case B search appears in trace with its darwinSearchId", !!evB, evB?.summary ?? "");
  const evText = JSON.stringify(ev.events);
  check("E: persisted trace holds no searchToken and no connectionPrompt blobs",
    !evText.includes("searchToken") && !evText.includes("connectionPrompt"));

  // ---- Case F: offer on the native match (end of the Dev B acceptance test) ----------------
  console.log("\n[F] Offer on the native match through the shared API");
  if (SKIP_OFFER) {
    console.log("    skipped (SKIP_OFFER=1)");
  } else if (!oak) {
    check("F: offer on Oak desk", false, "no native match to offer on");
  } else {
    const r = await fetch(`${BASE}/api/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listingId: oak.id, priceCents: 10000 }),
    });
    const body = (await r.json()) as { offer?: { id: string; status: string; proposedPriceCents: number }; error?: string };
    check("F: POST /api/offers → 201 open offer on D1 at $100",
      r.status === 201 && body.offer?.status === "open" && body.offer.proposedPriceCents === 10000,
      body.offer ? `${body.offer.id} ${body.offer.status} $${body.offer.proposedPriceCents / 100}` : `HTTP ${r.status} ${body.error ?? ""}`);
  }
  check("F: external capabilities are never offer targets (no listing id on them)",
    [...A.res.externalCapabilities, ...B.res.externalCapabilities].every((c) => !("id" in c) && !("listingId" in c)));

  // ---- Summary ---------------------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  - ${f.name}${f.info ? `  (${f.info})` : ""}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nAborted: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`Is the dev server running at ${BASE}?  (npm run dev)`);
  process.exitCode = 1;
});
