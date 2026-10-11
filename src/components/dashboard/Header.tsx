import Link from "next/link";

export function Header() {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-3 px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="flex items-center gap-3">
            <PingGlyph />
            <div>
              <p className="text-xl font-semibold leading-none tracking-tight">
                Ping<span className="text-accent">Market</span>
              </p>
              <p className="mt-1 text-[13px] text-muted">
                Text what you need. Discover offers across marketplaces.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/sim"
              className="rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Open simulated phones →
            </Link>
            <h1 className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
              Demo dashboard · operator view
            </h1>
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
            <strong className="font-semibold">Buyer input on this page is SIMULATED (web demo buyer).</strong>{" "}
            It did not arrive from a third phone. The seller and buyer handsets at <code className="font-mono">/sim</code> are
            also simulated and appear in the trace as <code className="font-mono">SIM</code>. The real buyer texts the
            PingMarket number from Number B over Dial SMS (tagged <code className="font-mono">Dial</code> in the trace); sellers
            negotiate here.
          </p>
        </div>
      </div>
    </header>
  );
}

function PingGlyph() {
  return (
    <svg viewBox="0 0 32 32" className="size-8 shrink-0 text-accent" aria-hidden>
      <circle cx="9" cy="23" r="3" fill="currentColor" />
      <path d="M9 14a9 9 0 0 1 9 9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path
        d="M9 6.5A16.5 16.5 0 0 1 25.5 23"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity="0.45"
      />
    </svg>
  );
}
