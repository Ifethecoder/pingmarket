"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { LiveDialResponse } from "@/app/api/live/dial/route";
import type { LiveKeewanoResponse } from "@/app/api/live/keewano/route";
import { apiFetch } from "../dashboard/api";
import { usePolling } from "../dashboard/hooks";
import { OffersPanel } from "../dashboard/OffersPanel";
import { ToastProvider } from "../dashboard/Toasts";
import { Chip, EmptyNote, ErrorNote, LiveStatus, Panel, RelativeTime, buttonClass } from "../dashboard/ui";
import { LivePhone } from "../sim/Phone";

const getDialLive = () => apiFetch<LiveDialResponse>("/api/live/dial");
const getKeewanoLive = () => apiFetch<LiveKeewanoResponse>("/api/live/keewano");

export function LiveMarketplace() {
  const [refreshToken, setRefreshToken] = useState(0);
  const bump = useCallback(() => setRefreshToken((n) => n + 1), []);
  const dial = usePolling(getDialLive, { intervalMs: 4000, refreshToken });
  const keewano = usePolling(getKeewanoLive, { intervalMs: 30000 });
  const connection = dial.data;

  return (
    <ToastProvider>
      <div className="flex min-h-full flex-1 flex-col">
        <header className="border-b border-border bg-surface">
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6">
            <div>
              <p className="text-xl font-semibold tracking-tight">Ping<span className="text-accent">Market</span></p>
              <h1 className="mt-1 text-sm text-muted">Live SMS & analytics</h1>
            </div>
            <nav aria-label="Marketplace views" className="flex gap-3">
              <Link href="/sim" className={buttonClass.secondary}>← Simulated phones</Link>
              <Link href="/dashboard" className={buttonClass.secondary}>Operator dashboard</Link>
            </nav>
          </div>
        </header>

        <main className="mx-auto grid w-full max-w-[1600px] flex-1 grid-cols-1 items-start gap-5 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)]">
          <LivePhone side="buyer" messages={connection?.messages ?? []} loading={dial.loading} error={dial.error} updatedAt={dial.updatedAt} number={connection?.participantNumber ?? null} onSent={dial.refresh} />
          <LivePhone side="service" messages={connection?.messages ?? []} loading={dial.loading} error={dial.error} updatedAt={dial.updatedAt} number={connection?.serviceNumber ?? null} onSent={dial.refresh} />
          <div className="flex min-w-0 flex-col gap-5">
            <Panel id="dial-connection" title="Dial connection" subtitle="Real SMS through your PingMarket number">
              <div className="space-y-3 p-4 text-sm">
                {dial.error && <ErrorNote message={dial.error} />}
                {!connection ? <p className="text-muted">Checking Dial configuration…</p> : <>
                  <div className="flex flex-wrap gap-2">
                    <Chip tone={connection.configured ? "success" : "warning"}>{connection.configured ? "Account configured" : "Account needs setup"}</Chip>
                    <Chip tone={connection.webhookReady ? "success" : "warning"}>{connection.webhookReady ? "Webhook secret configured" : "Webhook secret missing"}</Chip>
                    <Chip tone={connection.sendsEnabled ? "success" : "warning"}>{connection.sendsEnabled ? "SMS sending enabled" : "SMS sending disabled"}</Chip>
                  </div>
                  <p>Service number: <strong className="font-mono">{connection.serviceNumber ?? "Not configured"}</strong></p>
                  <p className="text-muted">Registered buyer: {connection.participantNumber ?? "Not configured"}</p>
                  {connection.configured && connection.serviceNumber && <>
                    <p>From the registered buyer phone, text <strong>HELP</strong> or <strong>SEARCH office chair under $100</strong> to this number. New messages appear below.</p>
                    <a href={`sms:${connection.serviceNumber}`} className={buttonClass.primary}>Open SMS to PingMarket</a>
                  </>}
                  <p className="text-xs text-muted">Incoming SMS must be forwarded by Dial to this app’s /api/dial/webhook. These checks confirm local configuration; an incoming message confirms the webhook connection.</p>
                </>}
              </div>
            </Panel>

            <Panel id="live-conversation" title="Real SMS conversation" subtitle="Latest 100 stored messages · updates every 4s" status={<LiveStatus updatedAt={dial.updatedAt} error={dial.error} loading={dial.loading} />}>
              <p className="border-b border-border px-4 py-2 text-xs text-muted">Messages from the registered buyer and service number. Stored outgoing messages are send attempts, not delivery receipts.</p>
              {connection?.messages.length ? <ol className="max-h-[32rem] space-y-3 overflow-auto p-4">
                {connection.messages.map((message) => <li key={message.id} className={`max-w-[90%] rounded-lg border border-border p-3 ${message.direction === "outbound" ? "ml-auto bg-accent/10" : "bg-surface-2"}`}>
                  <div className="mb-1 flex justify-between gap-4 text-[11px] text-muted">
                    <span>{message.direction === "inbound" ? "Buyer → PingMarket" : "PingMarket → Buyer"}</span>
                    <RelativeTime value={message.createdAt} />
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
                </li>)}
              </ol> : <EmptyNote>{dial.loading ? "Loading the conversation…" : "No real SMS messages in this app yet. Text the service number from the registered buyer phone."}</EmptyNote>}
            </Panel>
          </div>

          <div className="flex min-w-0 flex-col gap-5">
            <Panel id="keewano-live" title="Keewano analytics" subtitle="Live project queries · refreshes every 30s">
              <div className="space-y-3 p-4 text-sm">
                {keewano.error && <ErrorNote message={keewano.error} />}
                {!keewano.data ? <p className="text-muted">Checking Keewano…</p> : <>
                  <div className="flex flex-wrap gap-2">
                    <Chip tone={keewano.data.ingestionConfigured ? "success" : "warning"}>{keewano.data.ingestionConfigured ? "Event sending configured" : "Event sending needs setup"}</Chip>
                    <Chip tone={keewano.data.status === "connected" ? "success" : "warning"}>{keewano.data.status === "connected" ? "Live query connected" : keewano.data.status === "error" ? "Live query unavailable" : "Live query needs setup"}</Chip>
                  </div>
                  {keewano.data.status === "not_configured" && <p className="text-muted">Keewano credentials are missing. Analytics will appear here once the server connection is configured.</p>}
                  {!keewano.data.ingestionConfigured && keewano.data.queryConfigured && <p className="text-muted">Existing analytics can be queried, but this app is not sending new activity yet.</p>}
                  {keewano.data.status === "error" && <ErrorNote message="Could not query Keewano. Retrying on the next refresh." />}
                  {keewano.data.status === "connected" && <>
                    <dl className="grid grid-cols-2 gap-3">
                      <div className="rounded-md border border-border p-3"><dt className="text-xs text-muted">Tracked entities</dt><dd className="mt-1 text-2xl font-semibold tabular-nums">{keewano.data.entities?.toLocaleString() ?? "—"}</dd></div>
                      <div className="rounded-md border border-border p-3"><dt className="text-xs text-muted">Recorded events</dt><dd className="mt-1 text-2xl font-semibold tabular-nums">{keewano.data.events?.toLocaleString() ?? "—"}</dd></div>
                    </dl>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <caption className="mb-2 text-left font-medium">Counter history by marketplace</caption>
                        <thead className="text-muted"><tr><th scope="col" className="p-2">Marketplace</th><th scope="col" className="p-2">% of ask</th><th scope="col" className="p-2">Accepted</th><th scope="col" className="p-2">Declined</th></tr></thead>
                        <tbody>{keewano.data.counterBands.map((band) => <tr key={`${band.marketplace}:${band.band}`} className="border-t border-border"><td className="p-2">{band.marketplace}</td><td className="p-2">{band.band}</td><td className="p-2">{band.accepted}</td><td className="p-2">{band.declined}</td></tr>)}</tbody>
                      </table>
                    </div>
                    {!keewano.data.counterBands.length && <p className="text-muted">No counter history yet.</p>}
                    <p className="text-xs text-muted">Project totals include simulator activity and any synthetic backfill history. New activity may take about five minutes to appear.</p>
                    {keewano.data.queriedAt && <p className="text-xs text-muted">Last successful query <RelativeTime value={keewano.data.queriedAt} /></p>}
                  </>}
                  <button type="button" onClick={keewano.refresh} className={buttonClass.secondary}>Refresh analytics</button>
                </>}
              </div>
            </Panel>
            <OffersPanel source="sms" refreshToken={refreshToken} onChanged={bump} />
          </div>
        </main>
      </div>
    </ToastProvider>
  );
}
