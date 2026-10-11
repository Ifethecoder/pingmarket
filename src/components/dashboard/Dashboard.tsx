"use client";

import { useCallback, useState } from "react";
import { getMarketplaces } from "./api";
import { EventTracePanel } from "./EventTracePanel";
import { Header } from "./Header";
import { usePolling } from "./hooks";
import { ListingsPanel } from "./ListingsPanel";
import { OffersPanel } from "./OffersPanel";
import { SearchPanel } from "./SearchPanel";
import { ToastProvider } from "./Toasts";

export function Dashboard() {
  const marketplaces = usePolling(getMarketplaces, { intervalMs: 15000 });
  // Bumped after any write from this page so the polled panels refetch immediately.
  const [refreshToken, setRefreshToken] = useState(0);
  const bump = useCallback(() => setRefreshToken((n) => n + 1), []);

  return (
    <ToastProvider>
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
