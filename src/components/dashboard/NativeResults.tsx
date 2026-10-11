"use client";

import { useState } from "react";
import type { Marketplace, NativeListingResult } from "@/lib/types";
import { postOffer, errorMessage } from "./api";
import { formatCents, marketplaceName } from "./format";
import { useToast } from "./Toasts";
import { Chip, Spinner, buttonClass, inputClass } from "./ui";

export function NativeResults({
  results,
  marketplaces,
  onOfferSent,
}: {
  results: NativeListingResult[];
  marketplaces: Marketplace[];
  onOfferSent: () => void;
}) {
  return (
    <section aria-labelledby="native-results-heading" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="native-results-heading" className="flex items-center gap-2 text-sm font-semibold">
          <span aria-hidden className="size-2.5 rounded-sm bg-native" />
          Native listings (negotiable inside PingMarket)
        </h3>
        <span className="font-mono text-[11px] text-muted">{results.length} found</span>
      </div>
      {results.length === 0 ? (
        <p className="rounded-md border border-border bg-surface-2 px-3 py-3 text-xs text-muted">
          No native PingMarket listings matched this query.
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {results.map((r) => (
            <li key={r.id}>
              <NativeCard result={r} marketplaces={marketplaces} onOfferSent={onOfferSent} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const statusTone = { available: "success", reserved: "warning", sold: "neutral", removed: "neutral" } as const;

function NativeCard({
  result,
  marketplaces,
  onOfferSent,
}: {
  result: NativeListingResult;
  marketplaces: Marketplace[];
  onOfferSent: () => void;
}) {
  const toast = useToast();
  const [dollars, setDollars] = useState(() => String(Math.round((result.priceCents * 0.8) / 100)));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = `offer-${result.id}`;
  const closed = result.status === "sold" || result.status === "removed";
  const parsed = Number.parseFloat(dollars);
  const priceCents = Number.isFinite(parsed) ? Math.round(parsed * 100) : NaN;
  const valid = Number.isInteger(priceCents) && priceCents > 0;

  async function sendOffer(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || sending) return;
    setSending(true);
    setError(null);
    try {
      const { offer } = await postOffer({ listingId: result.id, priceCents });
      toast("success", `Offer ${offer.id} sent to seller by SMS`);
      onOfferSent();
    } catch (err) {
      const msg = errorMessage(err);
      setError(msg);
      toast("error", `Offer on ${result.id} failed: ${msg}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <article className="rounded-md border border-border border-l-4 border-l-native bg-surface p-3 shadow-[0_1px_0_0_var(--border)]">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-native px-1.5 py-px font-mono text-xs font-bold text-white dark:text-[#04261b]">
              {result.id}
            </span>
            <h4 className="truncate text-sm font-semibold">{result.title}</h4>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Chip tone="neutral">{marketplaceName(result.marketplaceId, marketplaces)}</Chip>
            {result.crossMarket && (
              <Chip tone="accent" className="font-semibold">
                ↗ Cross-market: from {marketplaceName(result.marketplaceId, marketplaces)}
              </Chip>
            )}
            <Chip tone={statusTone[result.status]}>{result.status}</Chip>
            {result.location && <span className="text-xs text-muted">· {result.location}</span>}
          </div>
        </div>
        <p className="font-mono text-lg font-semibold tabular-nums">
          {formatCents(result.priceCents, result.currency)}
        </p>
      </div>

      {result.description && <p className="mt-2 line-clamp-2 text-xs text-muted">{result.description}</p>}

      {result.matchReasons.length > 0 && (
        <ul aria-label="Match reasons" className="mt-2 flex flex-wrap gap-1">
          {result.matchReasons.map((reason) => (
            <li key={reason} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-muted">
              {reason}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={sendOffer} className="mt-3 flex flex-wrap items-center gap-2 border-t border-dashed border-border pt-3">
        <label htmlFor={inputId} className="text-xs font-medium text-muted">
          Offer on {result.id}
        </label>
        <div className="relative w-28">
          <span aria-hidden className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-sm text-muted">
            $
          </span>
          <input
            id={inputId}
            type="number"
            inputMode="decimal"
            min={1}
            step={1}
            value={dollars}
            onChange={(e) => setDollars(e.target.value)}
            className={`${inputClass} pl-6 font-mono tabular-nums`}
            aria-invalid={!valid}
            disabled={closed}
          />
        </div>
        <button type="submit" className={buttonClass.native} disabled={!valid || sending || closed}>
          {sending && <Spinner />}
          {sending ? "Sending…" : "Send offer"}
        </button>
        <span className="text-[11px] text-muted">as simulated web buyer</span>
        {error && (
          <p role="alert" className="basis-full font-mono text-xs text-danger">
            {error}
          </p>
        )}
      </form>
    </article>
  );
}
