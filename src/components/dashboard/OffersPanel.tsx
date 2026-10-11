"use client";

import { useRef, useState } from "react";
import type { Offer, OfferStatus } from "@/lib/types";
import { acceptOffer, errorMessage, getOffers } from "./api";
import { formatCents } from "./format";
import { usePolling } from "./hooks";
import { useToast } from "./Toasts";
import { Chip, EmptyNote, ErrorNote, LiveStatus, Panel, RelativeTime, Spinner, buttonClass, type Tone } from "./ui";

const statusTone: Record<OfferStatus, Tone> = {
  open: "accent",
  countered: "warning",
  accepted: "success",
  declined: "danger",
  expired: "neutral",
};

const versionKey = (o: Offer) => `${o.id}@${o.updatedAt}`;

export function OffersPanel({ refreshToken, onChanged }: { refreshToken: number; onChanged: () => void }) {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());

  const poll = usePolling(getOffers, {
    intervalMs: 4000,
    refreshToken,
    onSuccess: ({ offers }) => {
      const keys = offers.map(versionKey);
      if (seen.current) {
        const prev = seen.current;
        setFresh(new Set(keys.filter((k) => !prev.has(k))));
      }
      seen.current = new Set(keys);
    },
  });
  const offers = poll.data?.offers ?? [];

  return (
    <Panel
      id="offers"
      title="Negotiation"
      subtitle="Offers & counters · polled every 4s"
      status={<LiveStatus updatedAt={poll.updatedAt} error={poll.error} loading={poll.loading} />}
    >
      {poll.error && (
        <div className="px-4 pt-3">
          <ErrorNote prefix="GET /api/offers" message={poll.error} />
        </div>
      )}
      {offers.length === 0 ? (
        !poll.loading && !poll.error && <EmptyNote>No offers yet. Send one from a native listing result.</EmptyNote>
      ) : (
        <ul className="max-h-[22rem] divide-y divide-border/70 overflow-auto">
          {offers.map((o) => (
            <OfferRow
              key={o.id}
              offer={o}
              fresh={fresh.has(versionKey(o))}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function OfferRow({ offer, fresh, onChanged }: { offer: Offer; fresh: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const price = formatCents(offer.proposedPriceCents);

  async function accept() {
    setAccepting(true);
    setError(null);
    try {
      const { offer: updated } = await acceptOffer(offer.id);
      toast("success", `Offer ${updated.id} accepted at ${formatCents(updated.proposedPriceCents)}`);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAccepting(false);
    }
  }

  return (
    <li className={`px-4 py-2.5 ${fresh ? "motion-safe:animate-fresh" : ""}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-semibold tracking-wide">{offer.id}</span>
        <span className="text-muted">on</span>
        <span className="font-mono font-semibold text-native">{offer.listingId}</span>
        <span className="font-mono tabular-nums">{price}</span>
        <Chip tone={statusTone[offer.status]}>{offer.status}</Chip>
        {offer.source === "web_simulated" ? (
          <Chip tone="warning" title="Created from this dashboard, not from a real phone">
            simulated web buyer
          </Chip>
        ) : (
          <Chip tone="accent">SMS</Chip>
        )}
        <span className="ml-auto text-[11px] text-muted">
          updated <RelativeTime value={offer.updatedAt} />
        </span>
      </div>

      {offer.status === "countered" && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5">
          <p className="text-xs font-semibold">Seller countered: {price}</p>
          <button
            type="button"
            onClick={() => void accept()}
            disabled={accepting}
            className={`${buttonClass.native} ml-auto py-1`}
            aria-label={`Accept counteroffer of ${price} on offer ${offer.id}`}
          >
            {accepting && <Spinner />}
            Accept {price}
          </button>
          {error && (
            <p role="alert" className="basis-full font-mono text-[11px] text-danger">
              Accept failed: {error}
            </p>
          )}
        </div>
      )}
      {offer.status === "accepted" && (
        <p className="mt-1.5 text-xs font-medium text-success">Accepted — order pending payment</p>
      )}
    </li>
  );
}
