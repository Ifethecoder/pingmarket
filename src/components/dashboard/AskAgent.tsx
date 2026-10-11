"use client";

import { useState } from "react";
import type { DarwinActThreadView, DarwinActView } from "@/lib/darwin/act";
import { ApiError, errorMessage, getDarwinAct, postDarwinAct } from "./api";
import { useInterval } from "./hooks";
import { Chip, ErrorNote, Spinner, buttonClass, inputClass } from "./ui";

const POLL_MS = 2500;
const MAX_POLLS = 24; // about one minute

/**
 * Sends one read-only text message to a Darwin agent through Darwin Act and shows the thread.
 * PingMarket never answers payment, approval, or account-connection requests from the provider.
 */
export function AskAgent({
  searchId,
  agentId,
  capabilityId,
  defaultMessage,
}: {
  searchId: string;
  agentId: string;
  capabilityId: string;
  defaultMessage: string;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState(defaultMessage);
  const [sending, setSending] = useState(false);
  const [view, setView] = useState<DarwinActView | null>(null);
  const [failure, setFailure] = useState<{ message: string; code: string | null } | null>(null);
  const [polls, setPolls] = useState(0);

  const polling = view !== null && !view.done && polls < MAX_POLLS;
  useInterval(
    () => {
      if (!view) return;
      setPolls((n) => n + 1);
      getDarwinAct(view.actRequestId)
        .then(setView)
        .catch((err) => setFailure({ message: errorMessage(err), code: err instanceof ApiError ? err.code : null }));
    },
    polling ? POLL_MS : null,
  );

  async function send() {
    setSending(true);
    setFailure(null);
    setView(null);
    setPolls(0);
    try {
      setView(await postDarwinAct({ searchId, agentId, capabilityId, message: message.trim() }));
    } catch (err) {
      setFailure({ message: errorMessage(err), code: err instanceof ApiError ? err.code : null });
    } finally {
      setSending(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className={buttonClass.secondary} onClick={() => setOpen(true)}>
        Ask this agent via Darwin Act
      </button>
    );
  }

  const thread = view?.threads[0];
  return (
    <div className="mt-2 flex w-full flex-col gap-2 rounded-md border border-external/40 bg-external/[0.04] p-2.5">
      <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
        Message to the provider
        <textarea
          rows={2}
          maxLength={2000}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className={`${inputClass} font-normal normal-case tracking-normal`}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass.primary}
          disabled={sending || polling || message.trim().length === 0}
          onClick={send}
        >
          {sending && <Spinner />}
          {sending ? "Starting thread…" : "Send"}
        </button>
        <span className="text-[11px] text-muted">
          Text only. PingMarket never pays, approves, or connects accounts for external agents.
        </span>
      </div>

      {failure && <ErrorNote prefix={failure.code ?? "Darwin Act"} message={failure.message} />}

      {view && (
        <div className="flex flex-col gap-1.5 text-xs">
          <p className="flex flex-wrap items-center gap-2">
            <Chip tone={view.status === "failed" ? "danger" : view.done ? "success" : "warning"} title="Darwin Act request status">
              {view.status}
            </Chip>
            {polling && (
              <span className="flex items-center gap-1 text-muted">
                <Spinner /> waiting for the provider
              </span>
            )}
            {!view.done && !polling && <span className="text-muted">No reply yet. Stopped checking after a minute.</span>}
            <span className="ml-auto font-mono text-[10px] text-muted">{view.actRequestId}</span>
          </p>
          {thread && <ThreadView thread={thread} />}
        </div>
      )}
    </div>
  );
}

function ThreadView({ thread }: { thread: DarwinActThreadView }) {
  if (thread.errorCode) {
    return (
      <div role="status" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2">
        <p className="font-mono text-[11px] font-semibold text-danger">{thread.errorCode}</p>
        <p className="mt-0.5 text-foreground">
          {thread.errorExplanation ?? "Darwin could not start a thread with this agent."}
        </p>
        <p className="mt-1 text-[11px] text-muted">The request reached Darwin. The failure is on the provider route.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {thread.messages.length === 0 && <p className="text-muted">Thread open. No messages yet.</p>}
      {thread.messages.map((m) => (
        <div
          key={m.id || `${m.from}-${m.createdAt}`}
          className={`rounded-md border px-2.5 py-1.5 ${m.from === "you" ? "border-border bg-surface-2" : "border-external/40 bg-surface"}`}
        >
          <p className="mb-0.5 font-mono text-[10px] uppercase text-muted">
            {m.from === "you" ? "PingMarket" : m.from} · {m.type}
            {m.status ? ` · ${m.status}` : ""}
          </p>
          {m.text && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
          {m.data && (
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] text-muted">
              {m.data}
            </pre>
          )}
        </div>
      ))}
      {thread.requests.map((r) => (
        <p key={r.id || r.type} className="rounded-md border border-warning/45 bg-warning/10 px-2.5 py-1.5">
          <span className="font-mono text-[10px] text-warning">{r.type}</span> {r.summary}
        </p>
      ))}
      {thread.messages.some((m) => m.from === "agent" || m.type === "result") && (
        <p className="text-[11px] text-muted">
          Provider reply shown as received. It is not PingMarket inventory or a confirmed quote.
        </p>
      )}
    </div>
  );
}
