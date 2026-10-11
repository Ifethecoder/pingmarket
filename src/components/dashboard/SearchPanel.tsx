"use client";

import { useRef, useState } from "react";
import {
  MARKETPLACE_IDS,
  type DarwinSearchOutcome,
  type Marketplace,
  type MarketplaceId,
  type SearchRequest,
  type SearchResponse,
} from "@/lib/types";
import { ApiError, postSearch, errorMessage } from "./api";
import { ExternalResults } from "./ExternalResults";
import { marketplaceName } from "./format";
import { useInterval } from "./hooks";
import { NativeResults } from "./NativeResults";
import { ErrorNote, Panel, Spinner, buttonClass, inputClass } from "./ui";

const DEFAULT_QUERY = "desk under $150 in Berkeley; also interested in custom wall art";

interface SearchFailure {
  message: string;
  issues?: unknown;
}

export function SearchPanel({
  marketplaces,
  marketplacesError,
  onOfferSent,
}: {
  marketplaces: Marketplace[];
  marketplacesError: string | null;
  onOfferSent: () => void;
}) {
  const [marketplaceId, setMarketplaceId] = useState<MarketplaceId>("creative");
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [maxPrice, setMaxPrice] = useState("");
  const [location, setLocation] = useState("");
  const [includeExternal, setIncludeExternal] = useState(true);
  const [followUp, setFollowUp] = useState("");
  /** 1 = fresh search; each Darwin follow-up adds a turn. */
  const [turn, setTurn] = useState(1);

  const [loading, setLoading] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [failure, setFailure] = useState<SearchFailure | null>(null);
  const startedAt = useRef(0);

  useInterval(() => setElapsedMs(performance.now() - startedAt.current), loading ? 100 : null);

  const options: { id: MarketplaceId; label: string }[] =
    marketplaces.length > 0
      ? marketplaces.map((m) => ({ id: m.id, label: m.name }))
      : MARKETPLACE_IDS.map((id) => ({ id, label: marketplaceName(id, []) }));

  function baseBody(text: string): SearchRequest {
    const body: SearchRequest = { query: text, marketplaceId, includeExternalAgents: includeExternal };
    const max = Number.parseFloat(maxPrice);
    if (Number.isFinite(max) && max > 0) body.maxPriceCents = Math.round(max * 100);
    if (location.trim()) body.location = location.trim();
    return body;
  }

  async function submit(body: SearchRequest, isFollowUp: boolean) {
    startedAt.current = performance.now();
    setElapsedMs(0);
    setLoading(true);
    setFailure(null);
    try {
      const resp = await postSearch(body);
      setResult(resp);
      setTurn((t) => (isFollowUp ? t + 1 : 1));
      if (isFollowUp) setFollowUp("");
    } catch (err) {
      // A failed follow-up keeps the previous turn on screen so the buyer can retry or start over.
      if (!isFollowUp) setResult(null);
      setFailure({ message: errorMessage(err), issues: err instanceof ApiError ? err.issues : undefined });
    } finally {
      setElapsedMs(performance.now() - startedAt.current);
      setLoading(false);
    }
  }

  function runSearch() {
    const trimmed = query.trim();
    if (!trimmed || loading) return;
    void submit(baseBody(trimmed), false);
  }

  /** Continue the current Darwin search (`previousResponseId`). Darwin treats `text` as the new task. */
  function runFollowUp(text = followUp) {
    const trimmed = text.trim();
    const previousResponseId = result?.darwin.responseId;
    if (!trimmed || !previousResponseId || loading) return;
    void submit({ ...baseBody(trimmed), includeExternalAgents: true, previousResponseId }, true);
  }

  return (
    <Panel
      id="search"
      title="Buyer search"
      subtitle="Simulated web buyer · POST /api/search"
      status={
        elapsedMs !== null && (
          <span className="font-mono text-[11px] tabular-nums text-muted" aria-live="off">
            {loading ? "searching… " : "took "}
            {(elapsedMs / 1000).toFixed(1)}s
          </span>
        )
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch();
        }}
        className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto]"
      >
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label htmlFor="search-query" className="text-xs font-medium text-muted">
            What does the buyer need?
          </label>
          <textarea
            id="search-query"
            rows={2}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void runSearch();
              }
            }}
            className={`${inputClass} resize-y leading-relaxed`}
            required
            maxLength={2000}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 sm:col-span-2 md:grid-cols-[1.2fr_0.8fr_1fr]">
          <div className="col-span-2 flex flex-col gap-1 md:col-span-1">
            <label htmlFor="search-marketplace" className="text-xs font-medium text-muted">
              Searching from marketplace
            </label>
            <select
              id="search-marketplace"
              value={marketplaceId}
              onChange={(e) => setMarketplaceId(e.target.value as MarketplaceId)}
              className={inputClass}
            >
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="search-max-price" className="text-xs font-medium text-muted">
              Max price ($, optional)
            </label>
            <input
              id="search-max-price"
              type="number"
              inputMode="decimal"
              min={0}
              step={1}
              placeholder="150"
              value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)}
              className={`${inputClass} font-mono tabular-nums`}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="search-location" className="text-xs font-medium text-muted">
              Location (optional)
            </label>
            <input
              id="search-location"
              type="text"
              placeholder="Berkeley"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className={inputClass}
              maxLength={200}
            />
          </div>
        </div>

        <label className="flex cursor-pointer items-center gap-2 self-center text-xs">
          <input
            type="checkbox"
            checked={includeExternal}
            onChange={(e) => setIncludeExternal(e.target.checked)}
            className="size-4 accent-[var(--external)]"
          />
          Include external agents (Darwin Search)
        </label>
        <button type="submit" className={`${buttonClass.primary} px-5 py-2 text-sm`} disabled={loading || !query.trim()}>
          {loading && <Spinner />}
          {loading ? "Searching…" : "Search"}
        </button>

        {marketplacesError && (
          <p className="text-[11px] text-muted sm:col-span-2">
            Marketplace list unavailable (<span className="font-mono text-danger">{marketplacesError}</span>); using
            built-in ids.
          </p>
        )}
      </form>

      <div aria-live="polite" aria-busy={loading} className="flex flex-col gap-5 border-t border-border p-4">
        {failure && (
          <div className="flex flex-col gap-2">
            <ErrorNote prefix="Search failed" message={failure.message} />
            {failure.issues !== undefined && (
              <pre className="max-h-40 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-[10.5px]">
                {JSON.stringify(failure.issues, null, 2)}
              </pre>
            )}
          </div>
        )}
        {!failure && !result && !loading && (
          <p className="py-4 text-center text-xs text-muted">
            Run a search to see native PingMarket listings and Darwin-discovered external capabilities side by side.
          </p>
        )}
        {loading && !result && (
          <p className="flex items-center justify-center gap-2 py-4 text-xs text-muted">
            <Spinner /> Searching native listings{includeExternal ? " and Darwin Search in parallel" : ""}…
          </p>
        )}
        {result && (
          <div className={`flex flex-col gap-5 transition-opacity ${loading ? "opacity-50" : ""}`}>
            <p className="text-[11px] text-muted">
              Results for <span className="font-mono text-foreground">“{result.query}”</span>
              {result.marketplaceId && (
                <> · searched from {marketplaceName(result.marketplaceId, marketplaces)}</>
              )}
            </p>
            <NativeResults results={result.nativeListings} marketplaces={marketplaces} onOfferSent={onOfferSent} />
            <ExternalResults darwin={result.darwin} capabilities={result.externalCapabilities} />
            {result.darwin.responseId && (
              <FollowUpBox
                darwin={result.darwin}
                turn={turn}
                value={followUp}
                loading={loading}
                onChange={setFollowUp}
                onSubmit={runFollowUp}
              />
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

/**
 * Darwin follow-up (Search v3 `previousResponseId`): answer a `needs_input` question or refine the match.
 * The server holds the private continuation token; the browser only ever sees `responseId`.
 */
function FollowUpBox({
  darwin,
  turn,
  value,
  loading,
  onChange,
  onSubmit,
}: {
  darwin: DarwinSearchOutcome;
  turn: number;
  value: string;
  loading: boolean;
  onChange: (value: string) => void;
  onSubmit: (text?: string) => void;
}) {
  const needsInput = darwin.status === "needs_input";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      aria-labelledby="follow-up-heading"
      className="flex flex-col gap-2 rounded-lg border border-external/45 bg-external/[0.035] p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <label id="follow-up-heading" htmlFor="search-follow-up" className="text-sm font-semibold">
          {needsInput ? "Answer Darwin’s question" : "Follow up with Darwin"}
        </label>
        <span className="font-mono text-[10px] text-muted" title="Darwin responseId this follow-up continues">
          turn {turn} · continues {darwin.responseId}
        </span>
      </div>
      {needsInput && darwin.question && <p className="text-xs text-foreground">{darwin.question}</p>}
      <div className="flex gap-2">
        <input
          id="search-follow-up"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            needsInput
              ? "e.g. compare prices for a Herman Miller Aeron size B under $800"
              : "e.g. buy a used oak desk from a seller that ships to Berkeley"
          }
          className={inputClass}
          maxLength={2000}
          disabled={loading}
        />
        <button type="submit" className={`${buttonClass.primary} shrink-0 px-4`} disabled={loading || !value.trim()}>
          {loading && <Spinner />}
          {loading ? "Sending…" : "Send"}
        </button>
      </div>
      <p className="text-[11px] leading-snug text-muted">
        Darwin treats each follow-up as the new task (“latest task wins”), so restate the full request rather than
        only the missing detail. Native listings are re-searched with the follow-up text.
      </p>
      {darwin.relatedSearches.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted">Darwin suggests:</span>
          {darwin.relatedSearches.map((s) => (
            <button
              key={s.query}
              type="button"
              title={s.reason ?? undefined}
              onClick={() => onSubmit(s.query)}
              disabled={loading}
              className={buttonClass.secondary}
            >
              {s.query}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}
