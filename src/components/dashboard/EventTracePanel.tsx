"use client";

import { useRef, useState } from "react";
import type { TraceEvent, TraceEventKind } from "@/lib/events/types";
import { getEvents } from "./api";
import { usePolling } from "./hooks";
import { Chip, EmptyNote, ErrorNote, LiveStatus, Panel, RelativeTime, type Tone } from "./ui";

const kindStyle: Record<TraceEventKind, { tone: Tone; label: string }> = {
  sms_inbound: { tone: "accent", label: "SMS in" },
  sms_outbound: { tone: "accent", label: "SMS out" },
  listing_created: { tone: "native", label: "listing" },
  search: { tone: "neutral", label: "search" },
  darwin_search: { tone: "external", label: "darwin" },
  offer: { tone: "warning", label: "offer" },
  order_created: { tone: "native", label: "order" },
  payment: { tone: "success", label: "payment" },
};

/** Which SMS path a trace row took: real Dial phone vs the /sim demo handsets. */
function smsChannel(ev: TraceEvent): "dial" | "sim" | null {
  if (ev.kind !== "sms_inbound" && ev.kind !== "sms_outbound") return null;
  const channel = ev.detail?.channel;
  if (channel === "dial" || channel === "sim") return channel;
  if (ev.summary.startsWith("SIM ")) return "sim";
  if (ev.summary.startsWith("SMS ")) return "dial";
  return null;
}

const fetchEvents = () => getEvents(50);

export function EventTracePanel({ refreshToken }: { refreshToken: number }) {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());

  const poll = usePolling(fetchEvents, {
    intervalMs: 4000,
    refreshToken,
    onSuccess: ({ events }) => {
      const ids = events.map((e) => e.id);
      if (seen.current) {
        const prev = seen.current;
        setFresh(new Set(ids.filter((id) => !prev.has(id))));
      }
      seen.current = new Set(ids);
    },
  });
  const events = poll.data?.events ?? [];

  return (
    <Panel
      id="events"
      title="Event trace"
      subtitle="SMS, listings, searches, Darwin, offers · newest first"
      status={<LiveStatus updatedAt={poll.updatedAt} error={poll.error} loading={poll.loading} />}
    >
      {poll.error && (
        <div className="px-4 pt-3">
          <ErrorNote prefix="GET /api/events" message={poll.error} />
        </div>
      )}
      {events.length === 0 ? (
        !poll.loading && !poll.error && <EmptyNote>No events recorded yet.</EmptyNote>
      ) : (
        <ol className="max-h-[28rem] overflow-auto font-mono text-[11px]">
          {events.map((ev) => {
            const style = kindStyle[ev.kind] ?? { tone: "neutral" as Tone, label: ev.kind };
            const channel = smsChannel(ev);
            const hasDetail = ev.detail && Object.keys(ev.detail).length > 0;
            return (
              <li
                key={ev.id}
                className={`border-b border-border/60 px-4 py-1.5 last:border-0 ${channel === "dial" ? "border-l-2 border-l-accent bg-accent/5" : ""} ${fresh.has(ev.id) ? "motion-safe:animate-fresh" : ""}`}
              >
                <div className="flex items-start gap-2">
                  <Chip tone={style.tone} className="w-[4.75rem] justify-center font-mono" title={ev.kind}>
                    {style.label}
                  </Chip>
                  <RelativeTime value={ev.at} className="w-12 shrink-0 pt-0.5 text-right text-muted" />
                  <span className="min-w-0 flex-1 break-words pt-0.5 font-sans text-xs">
                    {channel && (
                      <Chip
                        tone={channel === "dial" ? "accent" : "neutral"}
                        className="mr-1.5 align-middle"
                        title={channel === "dial" ? "Real phone via Dial" : "Simulated handset (/sim)"}
                      >
                        {channel === "dial" ? "Dial" : "Sim"}
                      </Chip>
                    )}
                    {ev.summary}
                  </span>
                </div>
                {hasDetail && (
                  <details className="ml-[8.25rem] mt-0.5">
                    <summary className="cursor-pointer select-none text-[10.5px] text-muted hover:text-foreground">
                      detail
                    </summary>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2 text-[10.5px] leading-relaxed">
                      {JSON.stringify(ev.detail, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
