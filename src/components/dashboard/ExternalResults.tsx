"use client";

import { useState } from "react";
import type { DarwinCapabilityResult, DarwinReadiness, DarwinSearchOutcome } from "@/lib/types";
import { Chip, type Tone } from "./ui";

export function ExternalResults({
  darwin,
  capabilities,
}: {
  darwin: DarwinSearchOutcome;
  capabilities: DarwinCapabilityResult[];
}) {
  return (
    <section
      aria-labelledby="external-results-heading"
      className="flex flex-col gap-3 rounded-lg border-2 border-dashed border-external/45 bg-external/[0.035] p-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="external-results-heading" className="flex items-center gap-2 text-sm font-semibold">
          <span aria-hidden className="size-2.5 rounded-full border-2 border-external" />
          External agents / capabilities{" "}
          <span className="font-normal text-muted">(via Darwin Search — not inventory, not quotes)</span>
        </h3>
        {darwin.status === "completed" && (
          <span className="shrink-0 font-mono text-[11px] text-muted">{capabilities.length} found</span>
        )}
      </div>

      <DarwinStatus darwin={darwin} count={capabilities.length} />

      {darwin.assessment && (
        <div className="flex flex-wrap items-start gap-2 text-xs">
          <Chip tone="external" title="Darwin assessment outcome">
            {darwin.assessment.outcome}
          </Chip>
          <p className="min-w-0 flex-1 text-muted">{darwin.assessment.explanation}</p>
        </div>
      )}
      {darwin.overview && darwin.overview !== darwin.assessment?.explanation && (
        <p className="text-xs text-muted">
          <span className="font-medium text-foreground">Darwin overview:</span> {darwin.overview}
        </p>
      )}

      {capabilities.length > 0 && (
        <ol className="flex flex-col gap-2.5">
          {capabilities.map((c) => (
            <li key={`${c.agentId}:${c.capabilityId}`}>
              <CapabilityCard cap={c} />
            </li>
          ))}
        </ol>
      )}

      <p className="border-t border-dashed border-external/30 pt-2 text-[11px] leading-snug text-muted">
        Darwin results are discovered capabilities. PingMarket does not imply quotes, availability, or that the
        provider ran any task.
      </p>
    </section>
  );
}

function DarwinStatus({ darwin, count }: { darwin: DarwinSearchOutcome; count: number }) {
  const ids = darwin.searchId ? (
    <span className="ml-auto font-mono text-[10px] text-muted" title="Darwin searchId / responseId">
      {darwin.searchId}
      {darwin.responseId ? ` · ${darwin.responseId}` : ""}
    </span>
  ) : null;

  switch (darwin.status) {
    case "completed":
      return (
        <p className="flex flex-wrap items-center gap-2 text-xs">
          <span aria-hidden className="size-1.5 rounded-full bg-external" />
          <span className="font-medium">
            Live Darwin Search: {count} {count === 1 ? "capability" : "capabilities"}
            {darwin.latencyMs != null ? ` in ${darwin.latencyMs} ms` : ""}
          </span>
          {ids}
        </p>
      );
    case "needs_input":
      return (
        <div role="status" className="rounded-md border border-warning/45 bg-warning/10 px-3 py-2 text-xs">
          <p className="font-semibold text-warning">Darwin needs more detail:</p>
          <p className="mt-0.5 text-foreground">{darwin.question ?? "(no question provided)"}</p>
          {ids && <p className="mt-1 flex">{ids}</p>}
        </div>
      );
    case "no_match":
      return (
        <div role="status" className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs">
          Darwin found no matching agents: {darwin.noMatchReason ?? "no reason given"}
          {ids && <p className="mt-1 flex">{ids}</p>}
        </div>
      );
    case "error":
      return (
        <div role="alert" className="rounded-md border border-danger/45 bg-danger/10 px-3 py-2 text-xs text-danger">
          <span className="font-semibold">Darwin Search unavailable:</span>{" "}
          <span className="font-mono">{darwin.error ?? "unknown error"}</span>
        </div>
      );
    case "skipped":
      return <p className="text-xs text-muted">External agents not requested.</p>;
    default:
      return <p className="text-xs text-muted">Darwin status: {String(darwin.status)}</p>;
  }
}

const readinessTone: Record<DarwinReadiness, Tone> = {
  ready: "success",
  authentication_required: "warning",
  recheck_required: "warning",
  unavailable: "neutral",
};

function CapabilityCard({ cap }: { cap: DarwinCapabilityResult }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const descId = `cap-desc-${cap.capabilityId}`;
  // Only offer "Show more" when the 3-line clamp actually hides text.
  const measure = (el: HTMLParagraphElement | null) => {
    if (el && !expanded) setClamped(el.scrollHeight > el.clientHeight + 1);
  };

  return (
    <article className="rounded-md border border-dashed border-external/50 bg-surface p-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-external font-mono text-xs font-bold text-external"
          aria-label={`Rank ${cap.rank}`}
        >
          {cap.rank}
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold leading-snug">{cap.name}</h4>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Chip tone={readinessTone[cap.readiness] ?? "neutral"} title="Darwin readiness">
              {cap.readiness}
            </Chip>
            <Chip tone={cap.canStartThread ? "success" : "neutral"}>
              <span aria-hidden>{cap.canStartThread ? "●" : "○"}</span>
              {cap.canStartThread ? "can start thread" : "cannot start thread"}
            </Chip>
            {cap.providerCheck && (
              <span className="font-mono text-[10.5px] text-muted">providerCheck: {cap.providerCheck}</span>
            )}
          </div>
        </div>
      </div>

      {cap.description && (
        <div className="mt-2">
          <p id={descId} ref={measure} className={`text-xs leading-relaxed text-muted ${expanded ? "" : "line-clamp-3"}`}>
            {cap.description}
          </p>
          {(clamped || expanded) && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-controls={descId}
              className="mt-0.5 text-[11px] font-medium text-external hover:underline focus-visible:outline-2 focus-visible:outline-external"
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}

      <div className="mt-2.5 grid gap-x-4 gap-y-2.5 text-xs sm:grid-cols-2">
        <Facts title="Why it matched" items={cap.reasons} empty="No reasons given." />
        <Facts title="Uncertainties" items={cap.uncertainties} empty="None declared." tone="warning" />
        <div>
          <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Setup</p>
          {cap.requiredSetup ? (
            <p>
              <span className="font-mono">{cap.requiredSetup.kind}</span>
              {cap.requiredSetup.suppliedBy && <span className="text-muted"> · supplied by {cap.requiredSetup.suppliedBy}</span>}
              {cap.requiredSetup.description && <span className="block text-muted">{cap.requiredSetup.description}</span>}
            </p>
          ) : (
            <p className="text-muted">Setup: not declared (unknown)</p>
          )}
        </div>
        <div>
          <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Connection</p>
          {cap.connectionMethods.length === 0 ? (
            <p className="text-muted">No confirmed connection method</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {cap.connectionMethods.map((m, i) => (
                <li key={`${m.protocol}-${i}`} className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-external/15 px-1 font-mono text-[10.5px] font-semibold text-external">
                    {m.protocol}
                  </span>
                  <span className="font-mono text-[10.5px] text-muted">
                    endpoint: {m.endpointStatus ?? "unknown"}
                    {m.environment ? ` · ${m.environment}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-2 font-mono text-[10px] leading-4 text-muted">
        <dt>agentId</dt>
        <dd className="break-all">{cap.agentId}</dd>
        <dt>capabilityId</dt>
        <dd className="break-all">{cap.capabilityId}</dd>
        <dt>revision</dt>
        <dd>{cap.capabilityRevision ?? "—"}</dd>
      </dl>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-dashed border-border pt-2">
        <a
          href={cap.agentPageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-external hover:underline focus-visible:outline-2 focus-visible:outline-external"
        >
          View on Darwin index ↗
        </a>
      </div>
      {cap.connectionPrompt && (
        <details className="group mt-1.5">
          <summary className="cursor-pointer select-none text-xs font-medium text-muted hover:text-foreground">
            <span className="group-open:hidden">Show connection prompt</span>
            <span className="hidden group-open:inline">Hide connection prompt</span>
          </summary>
          <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-2 p-2.5 font-mono text-[10.5px] leading-relaxed">
            {cap.connectionPrompt}
          </pre>
        </details>
      )}
    </article>
  );
}

function Facts({
  title,
  items,
  empty,
  tone,
}: {
  title: string;
  items: string[];
  empty: string;
  tone?: "warning";
}) {
  return (
    <div>
      <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</p>
      {items.length === 0 ? (
        <p className="text-muted">{empty}</p>
      ) : (
        <ul className="flex list-disc flex-col gap-0.5 pl-4 marker:text-muted">
          {items.map((item, i) => (
            <li key={i} className={tone === "warning" ? "marker:text-warning" : ""}>
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
