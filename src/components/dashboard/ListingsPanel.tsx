"use client";

import { useRef, useState } from "react";
import type { Listing, Marketplace } from "@/lib/types";
import { getListings } from "./api";
import { formatCents, marketplaceName } from "./format";
import { usePolling } from "./hooks";
import { Chip, EmptyNote, ErrorNote, LiveStatus, Panel, RelativeTime, type Tone } from "./ui";

const statusTone: Record<Listing["status"], Tone> = {
  available: "success",
  reserved: "warning",
  sold: "neutral",
  removed: "neutral",
};

export function ListingsPanel({ marketplaces, refreshToken }: { marketplaces: Marketplace[]; refreshToken: number }) {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());

  const poll = usePolling(getListings, {
    intervalMs: 4000,
    refreshToken,
    onSuccess: ({ listings }) => {
      const ids = listings.map((l) => l.id);
      if (seen.current) {
        const prev = seen.current;
        setFresh(new Set(ids.filter((id) => !prev.has(id))));
      }
      seen.current = new Set(ids);
    },
  });
  const listings = poll.data?.listings ?? [];

  return (
    <Panel
      id="listings"
      title="Listings"
      subtitle="All marketplaces · polled every 4s"
      status={<LiveStatus updatedAt={poll.updatedAt} error={poll.error} loading={poll.loading} />}
    >
      {poll.error && (
        <div className="px-4 pt-3">
          <ErrorNote prefix="GET /api/listings" message={poll.error} />
        </div>
      )}
      {listings.length === 0 ? (
        !poll.loading && !poll.error && <EmptyNote>No listings yet. Text SELL … from Number B to create one.</EmptyNote>
      ) : (
        <div className="max-h-[22rem] overflow-auto">
          <table className="w-full min-w-[30rem] border-collapse text-left text-xs">
            <caption className="sr-only">Listings across all marketplaces, newest first</caption>
            <thead className="sticky top-0 z-10 bg-surface text-[10.5px] uppercase tracking-wide text-muted">
              <tr className="border-b border-border">
                <th scope="col" className="px-3 py-2 font-medium">ID</th>
                <th scope="col" className="px-2 py-2 font-medium">Title · location</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Price</th>
                <th scope="col" className="px-2 py-2 font-medium">Market</th>
                <th scope="col" className="px-2 py-2 font-medium">Status · visibility</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {listings.map((l) => (
                <tr
                  key={l.id}
                  className={`border-b border-border/70 last:border-0 ${fresh.has(l.id) ? "motion-safe:animate-fresh" : ""}`}
                >
                  <td className="px-3 py-1.5 font-mono font-semibold text-native">
                    {l.id}
                    {fresh.has(l.id) && <span className="sr-only"> (new)</span>}
                  </td>
                  <td className="max-w-[13rem] px-2 py-1.5">
                    <span className="block truncate" title={l.title}>{l.title}</span>
                    <span className="block truncate text-[10.5px] text-muted">{l.location ?? "no location"}</span>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatCents(l.priceCents, l.currency)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-muted">{marketplaceName(l.marketplaceId, marketplaces)}</td>
                  <td className="px-2 py-1.5">
                    <Chip tone={statusTone[l.status]}>{l.status}</Chip>
                    <span className="mt-0.5 block whitespace-nowrap font-mono text-[10px] text-muted" title={l.visibility}>
                      {l.visibility === "cross_market" ? "cross-market" : "own market only"}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right text-muted"><RelativeTime value={l.createdAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
