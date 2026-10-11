"use client";

import type { ReactNode } from "react";
import { formatAbsolute, formatRelative } from "./format";
import { useNow } from "./hooks";

export type Tone = "neutral" | "accent" | "native" | "external" | "success" | "warning" | "danger";

const chipTones: Record<Tone, string> = {
  neutral: "border-border bg-surface-2 text-muted",
  accent: "border-accent/30 bg-accent/10 text-accent",
  native: "border-native/35 bg-native/10 text-native",
  external: "border-external/35 bg-external/10 text-external",
  success: "border-success/35 bg-success/10 text-success",
  warning: "border-warning/40 bg-warning/10 text-warning",
  danger: "border-danger/40 bg-danger/10 text-danger",
};

export function Chip({
  tone = "neutral",
  children,
  className = "",
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${chipTones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function RelativeTime({ value, className = "" }: { value: string | number; className?: string }) {
  const now = useNow();
  const iso = new Date(value).toISOString();
  return (
    <time dateTime={iso} title={formatAbsolute(value)} className={`tabular-nums ${className}`}>
      {now === null ? "…" : formatRelative(value, now)}
    </time>
  );
}

/** Live/poll status indicator: pulsing dot when healthy, red when the last poll failed. */
export function LiveStatus({
  updatedAt,
  error,
  loading,
}: {
  updatedAt: number | null;
  error: string | null;
  loading: boolean;
}) {
  const state = error ? "error" : loading && updatedAt === null ? "loading" : "live";
  const dot =
    state === "error" ? "bg-danger" : state === "loading" ? "bg-muted" : "bg-accent";
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
      <span className="relative flex size-2" aria-hidden>
        {state === "live" && (
          <span className={`absolute inline-flex size-full rounded-full ${dot} opacity-60 motion-safe:animate-ping`} />
        )}
        <span className={`relative inline-flex size-2 rounded-full ${dot}`} />
      </span>
      {state === "loading" ? (
        "connecting…"
      ) : (
        <>
          {state === "error" ? "poll failed" : "live"}
          {updatedAt !== null && (
            <>
              {" · "}
              <RelativeTime value={updatedAt} />
            </>
          )}
        </>
      )}
    </span>
  );
}

export function Panel({
  id,
  title,
  subtitle,
  status,
  children,
  className = "",
}: {
  id: string;
  title: string;
  subtitle?: ReactNode;
  status?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const headingId = `${id}-heading`;
  return (
    <section
      aria-labelledby={headingId}
      className={`flex min-w-0 flex-col rounded-lg border border-border bg-surface ${className}`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <h2 id={headingId} className="text-[13px] font-semibold tracking-tight">
            {title}
          </h2>
          {subtitle && <p className="text-[11px] text-muted">{subtitle}</p>}
        </div>
        {status}
      </header>
      <div className="min-w-0 flex-1">{children}</div>
    </section>
  );
}

export function ErrorNote({ message, prefix = "Error" }: { message: string; prefix?: string }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
    >
      <span className="font-semibold">{prefix}:</span>{" "}
      <span className="font-mono break-words">{message}</span>
    </p>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-center text-xs text-muted">{children}</p>;
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block size-3.5 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin ${className}`}
    />
  );
}

export const buttonClass = {
  primary:
    "inline-flex items-center justify-center gap-2 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-ink transition-[filter,opacity] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50",
  secondary:
    "inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50",
  native:
    "inline-flex items-center justify-center gap-1.5 rounded-md bg-native px-3 py-1.5 text-xs font-semibold text-white transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-native disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#04261b]",
};

export const inputClass =
  "w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted/70 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25";
