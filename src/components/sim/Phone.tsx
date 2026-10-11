"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Marketplace, MarketplaceId, Message } from "@/lib/types";
import { errorMessage, getSimThread, postSimSms, type SimActor } from "../dashboard/api";
import { formatAbsolute } from "../dashboard/format";
import { usePolling } from "../dashboard/hooks";
import { Chip, ErrorNote, LiveStatus, Spinner, inputClass } from "../dashboard/ui";

const QUICK_REPLIES: Record<SimActor, string[]> = {
  seller: ["HELP", "SELL oak desk, $120, Berkeley. Pickup only.", "SELL brass lamp", "DETAILS D2", "REMOVE D8"],
  buyer: ["HELP", "SEARCH desk under $150 in Berkeley", "SEARCH office chair", "OFFER D2 80", "DETAILS D2", "AGENT 1"],
};

const ACTOR_LABEL: Record<SimActor, { title: string; who: string }> = {
  seller: { title: "Seller phone", who: "seeded seller u_seller_2 · owns D2, D4, D6, D8" },
  buyer: { title: "Buyer phone", who: "seeded demo buyer u_web_buyer · offers are web_simulated" },
};

function prettyNumber(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function Phone({
  actor,
  marketplaces,
  onActivity,
}: {
  actor: SimActor;
  marketplaces: Marketplace[];
  /** Called after this handset sends a text, so sibling panels can refetch at once. */
  onActivity: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [marketplaceId, setMarketplaceId] = useState<MarketplaceId>("furniture");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Bumped after our own send so the thread refetches without waiting for the next poll.
  const [refreshToken, setRefreshToken] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const poll = usePolling(() => getSimThread(actor), { intervalMs: 2000, refreshToken });
  const messages = poll.data?.messages ?? [];
  const handset = poll.data?.handset;
  const serviceNumber = poll.data?.serviceNumber ?? "+15550000001";

  async function send(text: string) {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await postSimSms({ actor, body, marketplaceId });
      setDraft("");
      setRefreshToken((n) => n + 1);
      onActivity();
    } catch (error) {
      setSendError(errorMessage(error));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(draft);
    }
  }

  const label = ACTOR_LABEL[actor];
  const headingId = `phone-${actor}-heading`;

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col items-center gap-3">
      <div className="w-full max-w-[400px] text-center">
        <h2 id={headingId} className="text-sm font-semibold tracking-tight">
          {label.title}
        </h2>
        <p className="mt-0.5 text-[11px] text-muted">{label.who}</p>
      </div>

      <div className="w-full max-w-[400px] rounded-[2.5rem] border border-border bg-[#0f1419] p-2.5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.45)] dark:bg-[#1c222d]">
        <div className="flex h-[640px] flex-col overflow-hidden rounded-[2rem] bg-surface">
          {/* Status bar */}
          <div className="relative flex items-center justify-between px-6 pt-3 pb-1 text-[11px] font-medium tabular-nums text-muted">
            <span>9:41</span>
            <span aria-hidden className="absolute left-1/2 top-2 h-5 w-24 -translate-x-1/2 rounded-full bg-[#0f1419] dark:bg-[#1c222d]" />
            <span className="flex items-center gap-1">
              <Chip tone="warning" className="!px-1.5 !py-0 !text-[9px] tracking-wider">
                SIMULATED
              </Chip>
            </span>
          </div>

          {/* Contact header */}
          <header className="flex flex-col items-center gap-0.5 border-b border-border px-4 pb-2.5 pt-1">
            <span aria-hidden className="flex size-9 items-center justify-center rounded-full bg-accent/15 text-accent">
              <PingMini />
            </span>
            <p className="text-[13px] font-semibold leading-tight">PingMarket</p>
            <p className="font-mono text-[10px] text-muted">{prettyNumber(serviceNumber)}</p>
            <p className="text-[10px] text-muted">
              from {handset ? prettyNumber(handset.number) : "…"}
            </p>
          </header>

          {/* Thread */}
          <Thread actor={actor} messages={messages} loading={poll.loading} error={poll.error} />

          {/* Quick replies */}
          <div className="flex gap-1.5 overflow-x-auto border-t border-border px-3 py-2 [scrollbar-width:thin]">
            {QUICK_REPLIES[actor].map((q) => (
              <button
                key={q}
                type="button"
                disabled={sending}
                onClick={() => void send(q)}
                className="shrink-0 rounded-full border border-border bg-surface-2 px-2.5 py-1 font-mono text-[11px] text-foreground transition-colors hover:border-accent/50 hover:bg-accent/10 disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>

          {/* Composer */}
          <form onSubmit={onSubmit} className="flex flex-col gap-1.5 border-t border-border px-3 pb-4 pt-2">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Text message"
                aria-label={`${label.title} message`}
                maxLength={2000}
                disabled={sending}
                className={`${inputClass} rounded-full`}
              />
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                aria-label="Send"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {sending ? <Spinner /> : <ArrowUp />}
              </button>
            </div>
            <div className="flex items-center justify-between gap-2 text-[10px] text-muted">
              <label className="flex items-center gap-1">
                texting the
                <select
                  value={marketplaceId}
                  onChange={(e) => setMarketplaceId(e.target.value as MarketplaceId)}
                  aria-label="Marketplace number"
                  className="rounded border border-border bg-surface px-1 py-0.5 text-[10px] text-foreground"
                >
                  {(marketplaces.length ? marketplaces : [{ id: "furniture" as const, name: "Furniture Market" }]).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                number
              </label>
              <LiveStatus updatedAt={poll.updatedAt} error={poll.error} loading={poll.loading} />
            </div>
            {sendError && <ErrorNote message={sendError} prefix="Not sent" />}
          </form>
        </div>
      </div>
    </section>
  );
}

function Thread({
  actor,
  messages,
  loading,
  error,
}: {
  actor: SimActor;
  messages: Message[];
  loading: boolean;
  error: string | null;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const lastId = messages.at(-1)?.id;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lastId]);

  return (
    <div role="log" aria-live="polite" aria-label={`${actor} conversation`} className="flex flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-3">
      {loading && messages.length === 0 && <p className="py-8 text-center text-xs text-muted">connecting…</p>}
      {error && messages.length === 0 && <ErrorNote message={error} prefix="Thread" />}
      {!loading && messages.length === 0 && !error && (
        <p className="px-4 py-8 text-center text-xs leading-relaxed text-muted">
          No texts yet. Tap a suggestion below or type a command. Try <span className="font-mono">HELP</span>.
        </p>
      )}
      {messages.map((m, i) => {
        const mine = m.direction === "inbound"; // inbound to PingMarket = sent from this phone
        const prev = messages[i - 1];
        const gap = prev && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > 5 * 60 * 1000;
        return (
          <div key={m.id} className="flex flex-col">
            {(i === 0 || gap) && (
              <p className="my-1.5 text-center text-[10px] text-muted">{formatAbsolute(m.createdAt)}</p>
            )}
            <div
              className={`max-w-[82%] whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-[13px] leading-snug ${
                mine
                  ? "self-end rounded-br-md bg-accent text-accent-ink"
                  : "self-start rounded-bl-md bg-surface-2 text-foreground"
              }`}
              title={formatAbsolute(m.createdAt)}
            >
              {m.body}
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

function ArrowUp() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
      <path d="M8 13V3m0 0L3.5 7.5M8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PingMini() {
  return (
    <svg viewBox="0 0 32 32" className="size-5" aria-hidden>
      <circle cx="9" cy="23" r="3" fill="currentColor" />
      <path d="M9 14a9 9 0 0 1 9 9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M9 6.5A16.5 16.5 0 0 1 25.5 23" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.45" />
    </svg>
  );
}
