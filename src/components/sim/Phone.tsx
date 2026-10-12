"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { Marketplace, MarketplaceId, Message } from "@/lib/types";
import { MARKETPLACE_IDS } from "@/lib/types";
import { errorMessage, getSimThread, postSimSms, type SimActor } from "../dashboard/api";
import { formatAbsolute } from "../dashboard/format";
import { usePolling } from "../dashboard/hooks";
import { ErrorNote, LiveStatus } from "../dashboard/ui";
import { BuyPanel, BUYER_MARKETPLACE_STORAGE_KEY } from "./BuyPanel";
import "./imessage.css";

const QUICK_REPLIES: Record<SimActor, string[]> = {
  seller: ["SELL oak desk, $120, Berkeley. Pickup only.", "SELL brass lamp", "DETAILS D2", "REMOVE D8"],
  buyer: ["SEARCH desk under $150 in Berkeley", "SEARCH office chair", "OFFER D2 80", "DETAILS D2", "AGENT 1"],
};

const ACTOR_LABEL: Record<SimActor, { title: string; who: string }> = {
  seller: { title: "Seller phone", who: "seeded seller u_seller_2 · owns D2, D4, D6, D8" },
  buyer: { title: "Buyer phone", who: "seeded demo buyer u_web_buyer · offers are web_simulated" },
};

/** Shown in the handset header: PingMarket's real Dial number. Simulated rows still use SIM_SERVICE_NUMBER. */
const DISPLAY_SERVICE_NUMBER = "+15075744885";

/** Messages-app style: a centered stamp appears when this much time separates two texts. */
const STAMP_GAP_MS = 15 * 60 * 1000;

function prettyNumber(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : e164;
}

const timeFormatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const weekdayFormatter = new Intl.DateTimeFormat("en-US", { weekday: "long" });
const dateFormatter = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });

/** "Today 9:41 AM", "Yesterday 9:41 AM", "Tuesday 9:41 AM", "Sat, Oct 4 at 9:41 AM" */
function stampParts(value: string): { day: string; time: string } {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { day: "", time: value };
  const time = timeFormatter.format(date);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(date)) / 86_400_000);
  if (days === 0) return { day: "Today", time };
  if (days === 1) return { day: "Yesterday", time };
  if (days > 1 && days < 7) return { day: weekdayFormatter.format(date), time };
  return { day: dateFormatter.format(date), time: `at ${time}` };
}

export function Phone({
  actor,
  marketplaces,
  onActivity,
  refreshToken: activityToken,
}: {
  actor: SimActor;
  marketplaces: Marketplace[];
  /** Called after this handset sends a text, so sibling panels can refetch at once. */
  onActivity: () => void;
  refreshToken: number;
}) {
  const [draft, setDraft] = useState("");
  const [marketplaceId, setMarketplaceId] = useState<MarketplaceId>("furniture");
  const [pending, setPending] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [buyOpen, setBuyOpen] = useState(false);
  // Rows returned by our own POST, shown until a poll catches up so the thread never flickers.
  const [local, setLocal] = useState<Message[]>([]);
  // Bumped after our own send so the thread refetches without waiting for the next poll.
  const [refreshToken, setRefreshToken] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (actor !== "buyer") return;
    try {
      const stored = window.sessionStorage.getItem(BUYER_MARKETPLACE_STORAGE_KEY);
      if (stored && MARKETPLACE_IDS.includes(stored as MarketplaceId)) {
        queueMicrotask(() => setMarketplaceId(stored as MarketplaceId));
      }
    } catch {
      // Use the default marketplace if storage is unavailable.
    }
  }, [actor]);

  const poll = usePolling(() => getSimThread(actor), {
    intervalMs: 2000,
    refreshToken: refreshToken + activityToken,
    onSuccess: (data) => setLocal((rows) => rows.filter((r) => !data.messages.some((m) => m.id === r.id))),
  });
  const polled = poll.data?.messages ?? [];
  const messages = local.length
    ? [...polled, ...local].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    : polled;
  const sending = pending !== null;

  async function send(text: string) {
    const body = text.trim();
    if (!body || sending) return;
    setPending(body);
    setDraft("");
    setSendError(null);
    try {
      const res = await postSimSms({ actor, body, marketplaceId });
      // Keep only this handset's side; notifications to the other phone show up over there.
      const handsetNumber = res.inbound.fromNumber;
      setLocal((rows) => [...rows, res.inbound, ...res.outbound.filter((m) => m.toNumber === handsetNumber)]);
      setRefreshToken((n) => n + 1);
      onActivity();
    } catch (error) {
      setDraft(body);
      setSendError(errorMessage(error));
    } finally {
      setPending(null);
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
      <div className="flex w-full max-w-[400px] flex-col items-center gap-1 text-center">
        <h2 id={headingId} className="text-sm font-semibold tracking-tight">
          {label.title}
        </h2>
        <p className="text-[11px] text-muted">{label.who}</p>
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-muted">
          <label className="flex items-center gap-1">
            texting the
            <select
              value={marketplaceId}
              onChange={(e) => setMarketplaceId(e.target.value as MarketplaceId)}
              aria-label="Marketplace number"
              className="rounded border border-border bg-surface px-1 py-0.5 text-[11px] text-foreground"
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
      </div>

      {/* Device */}
      <div className="imsg w-full max-w-[400px] rounded-[3.25rem] bg-black p-[11px] shadow-[0_0_0_2px_#3a3a3c,0_30px_70px_-24px_rgba(0,0,0,0.55)]">
        <div className="relative flex h-[700px] flex-col overflow-hidden rounded-[2.6rem] bg-(--imsg-screen) text-(--imsg-ink)">
          {/* Navigation bar (status bar + contact) */}
          <div className="relative z-10 border-b border-(--imsg-hairline) bg-(--imsg-bar) backdrop-blur-xl">
            <div className="relative flex h-11 items-center justify-between px-7 pt-1.5 text-[15px] font-semibold tabular-nums">
              <span>9:41</span>
              <span aria-hidden className="absolute left-1/2 top-2.5 h-[26px] w-[92px] -translate-x-1/2 rounded-full bg-black" />
              <StatusIcons />
            </div>
            <header className="grid grid-cols-[3.5rem_1fr_3.5rem] items-start px-2 pb-2 pt-1">
              <span aria-hidden className="flex h-11 items-center pl-1 text-(--imsg-sent)">
                <ChevronLeft />
              </span>
              <div className="flex flex-col items-center">
                <span
                  aria-hidden
                  className="flex size-12 items-center justify-center rounded-full bg-gradient-to-b from-[#a6acb9] to-[#858994] text-white"
                >
                  <PingMini />
                </span>
                <p className="mt-1 flex items-center gap-0.5 text-[12px] leading-tight">
                  PingMarket
                  <span aria-hidden className="text-(--imsg-meta)">
                    <ChevronRight />
                  </span>
                </p>
                <p className="text-[10px] tabular-nums text-(--imsg-meta)">{prettyNumber(DISPLAY_SERVICE_NUMBER)}</p>
              </div>
              <span className="flex h-11 items-center justify-end pr-1">
                <span
                  title="Simulated handset. Nothing here touches Dial."
                  className="rounded-full bg-[#ff9f0a] px-1.5 py-px text-[8.5px] font-bold uppercase tracking-wider text-black"
                >
                  Sim
                </span>
              </span>
            </header>
          </div>

          <Thread actor={actor} messages={messages} pending={pending} loading={poll.loading} error={poll.error} />

          {actor === "buyer" && (
            <BuyPanel open={buyOpen} marketplaceId={marketplaceId} refreshToken={refreshToken + activityToken} onActivity={onActivity} />
          )}

          {/* Suggestions */}
          <div className="flex gap-1.5 overflow-x-auto px-3 pb-1.5 pt-1 [scrollbar-width:none]">
            {actor === "buyer" && (
              <button
                type="button"
                disabled={sending}
                aria-expanded={buyOpen}
                aria-controls="buyer-purchases"
                onClick={() => setBuyOpen((open) => !open)}
                className="shrink-0 rounded-full border border-(--imsg-sent)/45 px-3 py-1 text-[13px] text-(--imsg-sent) transition-colors hover:bg-(--imsg-sent)/10 focus-visible:outline-2 focus-visible:outline-(--imsg-sent) disabled:opacity-40"
              >
                Buy
              </button>
            )}
            {QUICK_REPLIES[actor].map((q) => (
              <button
                key={q}
                type="button"
                disabled={sending}
                onClick={() => void send(q)}
                className="shrink-0 rounded-full border border-(--imsg-sent)/45 px-3 py-1 text-[13px] text-(--imsg-sent) transition-colors hover:bg-(--imsg-sent)/10 focus-visible:outline-2 focus-visible:outline-(--imsg-sent) disabled:opacity-40"
              >
                {q}
              </button>
            ))}
          </div>

          {/* Composer */}
          <form onSubmit={onSubmit} className="flex flex-col gap-1.5 px-3 pb-1 pt-1">
            {sendError && <ErrorNote message={sendError} prefix="Not delivered" />}
            <div className="flex min-h-[36px] items-center rounded-full border border-(--imsg-hairline) pl-3.5 pr-1 focus-within:border-(--imsg-meta)">
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="iMessage"
                aria-label={`${label.title} message`}
                maxLength={2000}
                disabled={sending}
                className="min-w-0 flex-1 bg-transparent py-1.5 text-[16px] text-(--imsg-ink) placeholder:text-(--imsg-meta) focus:outline-none"
              />
              {draft.trim() && (
                <button
                  type="submit"
                  disabled={sending}
                  aria-label="Send"
                  className="flex size-7 shrink-0 items-center justify-center rounded-full bg-(--imsg-sent) text-white transition-opacity hover:brightness-110 disabled:opacity-40"
                >
                  <ArrowUp />
                </button>
              )}
            </div>
          </form>

          {/* Home indicator */}
          <span aria-hidden className="mx-auto mb-2 mt-2 h-[5px] w-[134px] shrink-0 rounded-full bg-(--imsg-ink)" />
        </div>
      </div>
    </section>
  );
}

function Thread({
  actor,
  messages,
  pending,
  loading,
  error,
}: {
  actor: SimActor;
  messages: Message[];
  /** Text this handset is sending right now: shown as an outgoing bubble plus a typing indicator. */
  pending: string | null;
  loading: boolean;
  error: string | null;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const lastId = messages.at(-1)?.id;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lastId, pending]);

  // inbound to PingMarket = sent from this phone
  const lastMineIndex = messages.findLastIndex((m) => m.direction === "inbound");
  const showDelivered = pending === null && lastMineIndex !== -1 && lastMineIndex === messages.length - 1;

  return (
    <div
      role="log"
      aria-live="polite"
      aria-label={`${actor} conversation`}
      className="flex flex-1 flex-col overflow-y-auto px-4 pb-2 pt-3 [scrollbar-width:thin]"
    >
      {loading && messages.length === 0 && <p className="py-10 text-center text-[13px] text-(--imsg-meta)">Loading…</p>}
      {error && messages.length === 0 && <ErrorNote message={error} prefix="Thread" />}
      {!loading && messages.length === 0 && !error && pending === null && (
        <p className="px-6 py-10 text-center text-[13px] leading-relaxed text-(--imsg-meta)">
          Text Message
          <br />
          Tap a suggestion below or type a command.
        </p>
      )}
      {messages.map((m, i) => {
        const mine = m.direction === "inbound";
        const prev = messages[i - 1];
        const next = messages[i + 1];
        const stamp = !prev || startsGap(prev, m);
        const groupedWithPrev = !stamp && prev && sameSide(prev, m);
        const tail = !next || startsGap(m, next) || !sameSide(m, next) || (i === messages.length - 1 && pending !== null && !mine);
        const { day, time } = stampParts(m.createdAt);
        return (
          <div key={m.id} className="flex flex-col">
            {stamp && (
              <p className="mb-2 mt-3 text-center text-[11px] text-(--imsg-meta) first:mt-0">
                <span className="font-semibold">{day}</span> {time}
              </p>
            )}
            <Bubble mine={mine} tail={tail} spaced={!groupedWithPrev && !stamp} title={formatAbsolute(m.createdAt)}>
              <Linkified text={m.body} />
            </Bubble>
            {mine && i === lastMineIndex && showDelivered && (
              <p className="mt-0.5 self-end pr-1 text-[11px] font-medium text-(--imsg-meta)">Delivered</p>
            )}
          </div>
        );
      })}
      {pending !== null && (
        <>
          <Bubble mine tail spaced={messages.at(-1)?.direction !== "inbound"} className="opacity-70">
            {pending}
          </Bubble>
          <p className="mt-0.5 self-end pr-1 text-[11px] font-medium text-(--imsg-meta)">Sending…</p>
          <TypingBubble />
        </>
      )}
      <div ref={endRef} />
    </div>
  );
}

function sameSide(a: Message, b: Message): boolean {
  return a.direction === b.direction;
}

function startsGap(a: Message, b: Message): boolean {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() > STAMP_GAP_MS;
}

function Bubble({
  mine,
  tail,
  spaced,
  title,
  className = "",
  children,
}: {
  mine: boolean;
  tail: boolean;
  /** A new group starts here (other side spoke last), so leave room above. */
  spaced: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const side = mine
    ? `self-end bg-(--imsg-sent) text-white ${tail ? "imsg-tail-sent" : ""}`
    : `self-start bg-(--imsg-received) text-(--imsg-ink) ${tail ? "imsg-tail-received" : ""}`;
  return (
    <div
      title={title}
      className={`imsg-bubble max-w-[75%] whitespace-pre-wrap break-words rounded-[18px] px-3 py-[7px] text-[15px] leading-[20px] ${
        spaced ? "mt-2" : "mt-[2px]"
      } ${tail ? "mb-1" : ""} ${side} ${className}`}
    >
      {children}
    </div>
  );
}

const URL_PATTERN = /(https?:\/\/[^\s]+)/g;

/** Messages-style: URLs in a text are tappable (e.g. the Stripe test Checkout link). */
function Linkified({ text }: { text: string }) {
  return text.split(URL_PATTERN).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

function TypingBubble() {
  return (
    <div
      aria-label="PingMarket is typing"
      className="imsg-bubble imsg-tail-received mt-2 flex items-center gap-1 self-start rounded-[18px] bg-(--imsg-received) px-3.5 py-3"
    >
      {[0, 1, 2].map((n) => (
        <span
          key={n}
          aria-hidden
          className="imsg-typing-dot size-2 rounded-full bg-(--imsg-meta)"
          style={{ animationDelay: `${n * 0.18}s` }}
        />
      ))}
    </div>
  );
}

function StatusIcons() {
  return (
    <span aria-hidden className="flex items-center gap-1.5">
      <svg viewBox="0 0 18 12" className="h-3 w-[18px]" fill="currentColor">
        <rect x="0" y="8" width="3" height="4" rx="1" />
        <rect x="5" y="5.5" width="3" height="6.5" rx="1" />
        <rect x="10" y="3" width="3" height="9" rx="1" />
        <rect x="15" y="0" width="3" height="12" rx="1" />
      </svg>
      <svg viewBox="0 0 16 12" className="h-3 w-4" fill="currentColor">
        <path d="M8 2.6c2.2 0 4.2.85 5.7 2.25l1.1-1.15A9.9 9.9 0 0 0 8 1 9.9 9.9 0 0 0 1.2 3.7l1.1 1.15A8.2 8.2 0 0 1 8 2.6Z" />
        <path d="M8 5.9c1.3 0 2.5.5 3.4 1.3l1.1-1.15A6.6 6.6 0 0 0 8 4.3a6.6 6.6 0 0 0-4.5 1.75L4.6 7.2c.9-.8 2.1-1.3 3.4-1.3Z" />
        <path d="M8 9.1c.5 0 .9.15 1.2.45L8 10.8 6.8 9.55c.3-.3.7-.45 1.2-.45Z" />
      </svg>
      <svg viewBox="0 0 27 13" className="h-[13px] w-[27px]">
        <rect x="0.5" y="0.5" width="23" height="12" rx="3.5" fill="none" stroke="currentColor" opacity="0.4" />
        <rect x="2" y="2" width="20" height="9" rx="2" fill="currentColor" />
        <path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" fill="currentColor" opacity="0.4" />
      </svg>
    </span>
  );
}

function ChevronLeft() {
  return (
    <svg viewBox="0 0 12 20" className="h-[20px] w-3" aria-hidden>
      <path d="M10 2 2 10l8 8" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg viewBox="0 0 8 12" className="h-2.5 w-[7px]" aria-hidden>
      <path d="m2 2 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowUp() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
      <path d="M8 13V3m0 0L3.5 7.5M8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PingMini() {
  return (
    <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
      <circle cx="9" cy="23" r="3" fill="currentColor" />
      <path d="M9 14a9 9 0 0 1 9 9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M9 6.5A16.5 16.5 0 0 1 25.5 23" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.55" />
    </svg>
  );
}
