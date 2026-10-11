"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, getMarketplaces, postConfirm } from "./api";
import { EventTracePanel } from "./EventTracePanel";
import { Header } from "./Header";
import { usePolling } from "./hooks";
import { ListingsPanel } from "./ListingsPanel";
import { OffersPanel } from "./OffersPanel";
import { SearchPanel } from "./SearchPanel";
import { ToastProvider, useToast } from "./Toasts";

export function Dashboard() {
  const marketplaces = usePolling(getMarketplaces, { intervalMs: 15000 });
  // Bumped after any write from this page so the polled panels refetch immediately.
  const [refreshToken, setRefreshToken] = useState(0);
  const bump = useCallback(() => setRefreshToken((n) => n + 1), []);

  return (
    <ToastProvider>
      <CheckoutReturnNotice onConfirmed={bump} />
      <div className="flex min-h-full flex-1 flex-col">
        <Header />
        <main className="mx-auto grid w-full max-w-[1600px] flex-1 grid-cols-1 items-start gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            <SearchPanel
              marketplaces={marketplaces.data?.marketplaces ?? []}
              marketplacesError={marketplaces.error}
              onOfferSent={bump}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <ListingsPanel marketplaces={marketplaces.data?.marketplaces ?? []} refreshToken={refreshToken} />
            <OffersPanel refreshToken={refreshToken} onChanged={bump} />
            <EventTracePanel refreshToken={refreshToken} />
          </div>
        </main>
      </div>
    </ToastProvider>
  );
}

const CONFIRM_ATTEMPTS = 4;
const CONFIRM_RETRY_MS = 2000;

/**
 * Handles the Stripe return URL (`?checkout=success|cancel&order=…&session_id=…`). The URL itself proves
 * nothing: on success it asks the server to verify the Checkout Session with Stripe (POST /confirm),
 * retrying a few times while Stripe settles. Strips the query string either way.
 */
function CheckoutReturnNotice({ onConfirmed }: { onConfirmed: () => void }) {
  const toast = useToast();
  // StrictMode runs effects twice in dev; handle the return exactly once.
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    const url = new URL(window.location.href);
    const result = url.searchParams.get("checkout");
    if (result !== "success" && result !== "cancel") return;
    handled.current = true;
    const order = url.searchParams.get("order");
    const sessionId = url.searchParams.get("session_id") ?? undefined;
    for (const key of ["checkout", "order", "session_id"]) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);

    if (result === "cancel") {
      toast("error", `Checkout cancelled${order ? ` (order ${order})` : ""}`);
      return;
    }
    if (!order) {
      toast("error", "Returned from Stripe without an order id — use Check payment status");
      return;
    }
    void (async () => {
      for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise((r) => window.setTimeout(r, CONFIRM_RETRY_MS));
        try {
          const confirmation = await postConfirm(order, sessionId);
          if (confirmation.confirmed) {
            toast("success", `Payment confirmed — order ${confirmation.order.id} paid`);
            onConfirmed();
            return;
          }
        } catch (err) {
          toast("error", `Could not confirm payment for order ${order}: ${errorMessage(err)}`);
          return;
        }
      }
      toast("error", "Payment not confirmed yet — use Check payment status");
    })();
  }, [toast, onConfirmed]);
  return null;
}
