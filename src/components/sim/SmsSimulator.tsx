"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, getMarketplaces, postConfirm } from "../dashboard/api";
import { EventTracePanel } from "../dashboard/EventTracePanel";
import { usePolling } from "../dashboard/hooks";
import { Phone } from "./Phone";
import { readSimPhotos, SIM_PHOTOS_STORAGE_KEY, type SimPhotos } from "./photos";

export function SmsSimulator() {
  const marketplaces = usePolling(getMarketplaces, { intervalMs: 15000 });
  const [refreshToken, setRefreshToken] = useState(0);
  const bump = useCallback(() => setRefreshToken((n) => n + 1), []);
  const list = marketplaces.data?.marketplaces ?? [];
  const [photos, setPhotos] = useState<SimPhotos>({});

  useEffect(() => {
    try {
      const saved = readSimPhotos(window.sessionStorage.getItem(SIM_PHOTOS_STORAGE_KEY));
      queueMicrotask(() => setPhotos(saved));
    } catch {
      // Photos still work in memory when browser storage is unavailable.
    }
  }, []);

  function attachPhoto(listingId: string, photo: string) {
    setPhotos((current) => {
      const next = { ...current, [listingId]: photo };
      try {
        window.sessionStorage.setItem(SIM_PHOTOS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Keep the preview available even if the browser storage quota is full.
      }
      return next;
    });
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-3 px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <div>
              <p className="text-xl font-semibold leading-none tracking-tight">
                Ping<span className="text-accent">Market</span>
              </p>
              <p className="mt-1 text-[13px] text-muted">Simulated handsets · text the marketplace like a real seller and buyer.</p>
            </div>
            <div className="flex items-center gap-4">
              <Link href="/live" className="rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                Live SMS & analytics →
              </Link>
              <Link
                href="/dashboard"
                className="rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                ← Operator dashboard
              </Link>
              <h1 className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Demo · simulated SMS</h1>
            </div>
          </div>
        </div>
      </header>

      <CheckoutReturnNotice onConfirmed={bump} />

      <main className="mx-auto grid w-full max-w-[1600px] flex-1 grid-cols-1 items-start gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)]">
        <Phone actor="seller" photos={photos} onPhoto={attachPhoto} marketplaces={list} onActivity={bump} refreshToken={refreshToken} />
        <Phone actor="buyer" photos={photos} onPhoto={attachPhoto} marketplaces={list} onActivity={bump} refreshToken={refreshToken} />
        <div className="min-w-0 lg:sticky lg:top-4">
          <EventTracePanel refreshToken={refreshToken} />
        </div>
      </main>
    </div>
  );
}

type ReturnNotice = {
  orderId: string | null;
  sessionId?: string;
  message: string;
  status: "checking" | "paid" | "pending" | "error" | "cancelled";
};

/** A Stripe redirect is only a prompt to verify payment, never evidence that an item was purchased. */
function CheckoutReturnNotice({ onConfirmed }: { onConfirmed: () => void }) {
  const handled = useRef(false);
  const checking = useRef(false);
  const [notice, setNotice] = useState<ReturnNotice | null>(null);

  const confirm = useCallback(async (orderId: string, sessionId?: string) => {
    if (checking.current) return;
    checking.current = true;
    setNotice({ orderId, sessionId, status: "checking", message: "Checking your payment with Stripe…" });
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 2000));
        const result = await postConfirm(orderId, sessionId);
        if (result.confirmed) {
          setNotice({ orderId, sessionId, status: "paid", message: `Payment confirmed for order ${result.order.id}. Check the seller phone for the purchase notification.` });
          onConfirmed();
          return;
        }
      }
      setNotice({ orderId, sessionId, status: "pending", message: "Stripe has not confirmed payment yet. Check again shortly." });
    } catch (error) {
      setNotice({ orderId, sessionId, status: "error", message: `Could not verify payment: ${errorMessage(error)}` });
    } finally {
      checking.current = false;
    }
  }, [onConfirmed]);

  useEffect(() => {
    if (handled.current) return;
    const url = new URL(window.location.href);
    const result = url.searchParams.get("checkout");
    if (result !== "success" && result !== "cancel") return;
    handled.current = true;
    const orderId = url.searchParams.get("order");
    const sessionId = url.searchParams.get("session_id") ?? undefined;
    for (const key of ["checkout", "order", "session_id"]) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    queueMicrotask(() => {
      if (result === "cancel") {
        setNotice({ orderId, sessionId, status: "cancelled", message: "Checkout cancelled. Your item remains reserved; resume checkout from the buyer's purchase panel." });
      } else if (!orderId) {
        setNotice({ orderId: null, status: "error", message: "Stripe returned without an order ID. Use Check payment in the buyer's purchase panel." });
      } else {
        void confirm(orderId, sessionId);
      }
    });
  }, [confirm]);

  if (!notice) return null;
  return (
    <div className="mx-auto mt-4 w-full max-w-[1600px] px-4 sm:px-6">
      <div role={notice.status === "error" ? "alert" : "status"} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface p-3 text-sm">
        <p>{notice.message}</p>
        {notice.orderId && (notice.status === "pending" || notice.status === "error" || notice.status === "cancelled") && (
          <button type="button" onClick={() => void confirm(notice.orderId!, notice.sessionId)} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-accent focus-visible:outline-2 focus-visible:outline-accent">
            Check payment
          </button>
        )}
      </div>
    </div>
  );
}
