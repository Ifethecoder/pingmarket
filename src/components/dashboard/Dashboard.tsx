"use client";

import { useCallback, useEffect, useState } from "react";
import { getMarketplaces } from "./api";
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
      <CheckoutReturnNotice />
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

/**
 * Handles the Stripe return URL (`?checkout=success|cancel&order=…`): one toast, then strips the query.
 * A success return is NOT proof of payment; the order turns `paid` only via the signed webhook.
 */
function CheckoutReturnNotice() {
  const toast = useToast();
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("checkout");
    if (result !== "success" && result !== "cancel") return;
    const order = url.searchParams.get("order");
    if (result === "success") {
      toast("success", `Returned from Stripe${order ? ` (order ${order})` : ""} — waiting for webhook confirmation`);
    } else {
      toast("error", `Checkout cancelled${order ? ` (order ${order})` : ""}`);
    }
    url.searchParams.delete("checkout");
    url.searchParams.delete("order");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [toast]);
  return null;
}
