"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { getMarketplaces } from "../dashboard/api";
import { EventTracePanel } from "../dashboard/EventTracePanel";
import { usePolling } from "../dashboard/hooks";
import { Phone } from "./Phone";

export function SmsSimulator() {
  const marketplaces = usePolling(getMarketplaces, { intervalMs: 15000 });
  const [refreshToken, setRefreshToken] = useState(0);
  const bump = useCallback(() => setRefreshToken((n) => n + 1), []);
  const list = marketplaces.data?.marketplaces ?? [];

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-3 px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <div>
              <p className="text-xl font-semibold leading-none tracking-tight">
                Ping<span className="text-accent">Market</span>
              </p>
              <p className="mt-1 text-[13px] text-muted">Simulated handsets · text the marketplace like a real seller and buyer.</p>
            </div>
            <div className="flex items-center gap-4">
              <Link
                href="/dashboard"
                className="rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                ← Operator dashboard
              </Link>
              <h1 className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Demo · simulated SMS</h1>
            </div>
          </div>
          <div
            role="note"
            aria-label="Demo honesty notice"
            className="flex items-start gap-2.5 rounded-md border border-warning/45 bg-warning/10 px-3 py-2 text-[13px] leading-snug"
          >
            <span
              aria-hidden
              className="mt-px shrink-0 rounded-sm bg-warning px-1.5 py-px font-mono text-[10px] font-bold tracking-wider text-surface"
            >
              SIMULATED
            </span>
            <p>
              <strong className="font-semibold">Nothing on this page touches Dial.</strong> Texts go straight to the same SMS
              command parser and marketplace services the real webhook will use, and land in the trace labelled{" "}
              <code className="font-mono">SIM</code>. The seller phone is the seeded <code className="font-mono">u_seller_2</code>,
              not the real Dial seller. ACCEPT / COUNTER / DECLINE wait on the negotiation service.
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1600px] flex-1 grid-cols-1 items-start gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)]">
        <Phone actor="seller" marketplaces={list} onActivity={bump} />
        <Phone actor="buyer" marketplaces={list} onActivity={bump} />
        <div className="min-w-0 lg:sticky lg:top-4">
          <EventTracePanel refreshToken={refreshToken} />
        </div>
      </main>
    </div>
  );
}
