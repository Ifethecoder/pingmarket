"use client";

import { useRef, useState } from "react";
import type { MarketplaceId } from "@/lib/types";
import { errorMessage, getListings, getOffers, getOrders, postConfirm, postSimBuy } from "../dashboard/api";
import { formatCents } from "../dashboard/format";
import { usePolling } from "../dashboard/hooks";
import { simulatorPurchases } from "./purchases";
import { listingPhotoSource, type SimPhotos } from "./photos";

export const BUYER_MARKETPLACE_STORAGE_KEY = "pingmarket.sim.buyer-marketplace";

export function BuyPanel({ open, marketplaceId, refreshToken, onActivity, photos }: {
  photos: SimPhotos;
  open: boolean;
  marketplaceId: MarketplaceId;
  refreshToken: number;
  onActivity: () => void;
}) {
  const inventory = usePolling(async () => {
    const [listings, offers, orders] = await Promise.all([getListings(), getOffers(), getOrders()]);
    return { ...listings, ...offers, ...orders };
  }, { intervalMs: 2000, refreshToken });
  const [pending, setPending] = useState<string | null>(null);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const purchases = inventory.data
    ? simulatorPurchases(inventory.data.listings, inventory.data.offers, inventory.data.orders, marketplaceId)
    : [];

  async function buy(listingId: string) {
    if (busy.current) return;
    busy.current = true;
    setPending(listingId);
    setError(null);
    setNotice("Opening Stripe checkout…");
    try {
      const checkout = await postSimBuy(listingId);
      onActivity();
      try {
        window.sessionStorage.setItem(BUYER_MARKETPLACE_STORAGE_KEY, marketplaceId);
      } catch {
        // Checkout still works when the browser disables session storage.
      }
      window.location.assign(checkout.url);
      // Keep actions disabled while the browser leaves for Stripe.
    } catch (error) {
      busy.current = false;
      setPending(null);
      setNotice(null);
      setError(errorMessage(error));
      inventory.refresh();
      onActivity();
    }
  }

  async function checkPayment(orderId: string, listingId: string) {
    if (busy.current) return;
    busy.current = true;
    setPending(listingId);
    setError(null);
    setNotice("Checking payment with Stripe…");
    try {
      const confirmation = await postConfirm(orderId);
      setNotice(confirmation.confirmed ? "Payment confirmed. Check the seller phone for the purchase notification." : "Payment has not been confirmed yet. Complete Stripe checkout or check again.");
      onActivity();
      inventory.refresh();
    } catch (error) {
      setError(errorMessage(error));
      setNotice(null);
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  if (!open) return null;

  return (
    <section id="buyer-purchases" aria-labelledby="sim-buy-heading" className="flex max-h-[210px] shrink-0 flex-col border-t border-(--imsg-hairline) bg-(--imsg-bar) px-3 py-2 text-(--imsg-ink)">
      <div className="flex items-center justify-between gap-2">
        <h3 id="sim-buy-heading" className="text-[12px] font-semibold">Marketplace</h3>
        <span className="text-[10px] text-(--imsg-meta)">Stripe · test mode</span>
      </div>
      {inventory.error && <p role="alert" className="mt-1 text-[11px]">Could not load purchases: {inventory.error}</p>}
      {error && <p role="alert" className="mt-1 text-[11px]">Purchase: {error}</p>}
      {(notice || inventory.loading) && <p role="status" className="mt-1 text-[11px] text-(--imsg-meta)">{notice ?? "Loading items…"}</p>}
      {!inventory.loading && !inventory.error && !purchases.length && <p className="mt-1 text-[11px] text-(--imsg-meta)">No seller items available in this marketplace.</p>}
      <ul className="mt-1.5 min-h-0 max-h-[150px] space-y-1.5 overflow-y-auto">
        {purchases.map(({ listing, order, amountCents }, index) => {
          const paid = order?.paymentStatus === "paid";
          const oakDeskIndex = purchases
            .slice(0, index)
            .filter(({ listing: previous }) => /\boak desk\b/i.test(previous.title)).length;
          const photo = listingPhotoSource(listing.id, listing.title, oakDeskIndex, photos);
          return (
            <li key={listing.id} className="rounded-lg border border-(--imsg-hairline) bg-(--imsg-screen) px-2.5 py-2">
              {photo && (
                // Simulation photos stay in browser session state, including the built-in asset.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photo} alt={listing.title} className="mb-2 max-h-32 w-full rounded-md object-contain" />
              )}
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-medium" title={listing.title}>{listing.id} · {listing.title}</p>
                  <p className="mt-0.5 text-[11px] text-(--imsg-meta)">{formatCents(amountCents, listing.currency)}{listing.status === "reserved" ? " · Reserved for you" : ""}</p>
                </div>
                {paid ? <span className="text-[11px] font-medium text-(--imsg-sent)">Purchased</span> : (
                  <button
                    type="button"
                    disabled={pending !== null || inventory.error !== null}
                    onClick={() => void buy(listing.id)}
                    aria-label={`Buy ${listing.title} for ${formatCents(amountCents, listing.currency)}`}
                    className="shrink-0 rounded-full bg-(--imsg-sent) px-3 py-1.5 text-[12px] font-semibold text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--imsg-sent) disabled:opacity-50"
                  >
                    {pending === listing.id ? "Working…" : order?.stripeCheckoutSessionId ? "Resume checkout" : "Buy"}
                  </button>
                )}
              </div>
              {order && !paid && (
                <button type="button" disabled={pending !== null} onClick={() => void checkPayment(order.id, listing.id)} className="mt-1 text-[11px] text-(--imsg-sent) underline focus-visible:outline-2 focus-visible:outline-(--imsg-sent) disabled:opacity-50">
                  Check payment
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
