"use client";

import { useEffect, useRef, useState } from "react";
import type { Offer, OfferSource, OfferStatus, Order } from "@/lib/types";
import type { NegotiationInsight } from "@/lib/keewano/insight";
import { acceptOffer, ApiError, counterOffer, declineOffer, errorMessage, getOfferInsight, getOffers, getOrders, postCheckout, postConfirm, postOrder, postPayout } from "./api";
import { formatCents } from "./format";
import { usePolling } from "./hooks";
import { useToast } from "./Toasts";
import { Chip, EmptyNote, ErrorNote, LiveStatus, Panel, RelativeTime, Spinner, buttonClass, inputClass, type Tone } from "./ui";

const statusTone: Record<OfferStatus, Tone> = {
  open: "accent",
  countered: "warning",
  accepted: "success",
  declined: "danger",
  expired: "neutral",
};

const versionKey = (o: Offer) => `${o.id}@${o.updatedAt}`;

export function OffersPanel({ refreshToken, onChanged, source }: { refreshToken: number; onChanged: () => void; source?: OfferSource }) {
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
  const offers = (poll.data?.offers ?? []).filter((offer) => !source || offer.source === source);
  const ordersPoll = usePolling(getOrders, { intervalMs: 4000, refreshToken });
  const orderByOffer = new Map((ordersPoll.data?.orders ?? []).map((o) => [o.offerId, o]));
  // Until the first orders poll lands we cannot tell "unpaid" from "paid": no pay button yet.
  const ordersReady = ordersPoll.data !== null || !ordersPoll.loading;

  return (
    <Panel
      id="offers"
      title="Negotiation"
      subtitle={source === "sms" ? "SMS buyer offers & counters · seller actions send real messages" : "Offers & counters · polled every 4s"}
      status={<LiveStatus updatedAt={poll.updatedAt} error={poll.error} loading={poll.loading} />}
    >
      {poll.error && (
        <div className="px-4 pt-3">
          <ErrorNote prefix="GET /api/offers" message={poll.error} />
        </div>
      )}
      {ordersPoll.error && (
        <div className="px-4 pt-3">
          <ErrorNote prefix="GET /api/orders" message={ordersPoll.error} />
        </div>
      )}
      {offers.length === 0 ? (
        !poll.loading && !poll.error && <EmptyNote>{source === "sms" ? "No SMS offers yet. The buyer can text OFFER <listing ID> <price>." : "No offers yet. Send one from a native listing result."}</EmptyNote>
      ) : (
        <ul className="max-h-[22rem] divide-y divide-border/70 overflow-auto">
          {offers.map((o) => (
            <OfferRow
              key={o.id}
              offer={o}
              order={orderByOffer.get(o.id) ?? null}
              ordersReady={ordersReady}
              fresh={fresh.has(versionKey(o))}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function OfferRow({
  offer,
  order,
  ordersReady,
  fresh,
  onChanged,
}: {
  offer: Offer;
  order: Order | null;
  ordersReady: boolean;
  fresh: boolean;
  onChanged: () => void;
}) {
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
          <Chip tone="accent" title="Offer texted from the buyer's phone via Dial">
            SMS buyer
          </Chip>
        )}
        <span className="ml-auto text-[11px] text-muted">
          updated <RelativeTime value={offer.updatedAt} />
        </span>
      </div>

      {offer.status === "open" && <SellerActions offer={offer} onChanged={onChanged} />}
      {offer.status === "countered" && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5">
          <p className="text-xs font-semibold">Seller countered: {price}</p>
          {offer.source === "web_simulated" ? (
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
          ) : (
            <p className="ml-auto text-xs text-muted">Awaiting the SMS buyer (they reply ACCEPT/DECLINE by text)</p>
          )}
          {error && (
            <p role="alert" className="basis-full font-mono text-[11px] text-danger">
              Accept failed: {error}
            </p>
          )}
        </div>
      )}
      {offer.status === "accepted" && (
        <OrderPayment offer={offer} order={order} ready={ordersReady} onChanged={onChanged} />
      )}
    </li>
  );
}

/** Seller console for an open offer: accept, counter with a price, or decline. */
function SellerActions({ offer, onChanged }: { offer: Offer; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<"accept" | "counter" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [counter, setCounter] = useState((offer.proposedPriceCents / 100).toFixed(2));
  const price = formatCents(offer.proposedPriceCents);

  const dollars = Number.parseFloat(counter);
  const counterCents = Math.round(dollars * 100);
  const counterValid = Number.isFinite(dollars) && counterCents >= 100;

  async function run(action: "accept" | "counter" | "decline") {
    setBusy(action);
    setError(null);
    try {
      if (action === "accept") {
        const { offer: u } = await acceptOffer(offer.id);
        toast("success", `Offer ${u.id} accepted at ${formatCents(u.proposedPriceCents)}`);
      } else if (action === "counter") {
        const { offer: u } = await counterOffer(offer.id, counterCents);
        toast("success", `Countered offer ${u.id} at ${formatCents(u.proposedPriceCents)}`);
      } else {
        const { offer: u } = await declineOffer(offer.id);
        toast("success", `Offer ${u.id} declined`);
      }
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const disabled = busy !== null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1.5">
      <Chip tone="accent" title="This dashboard is the seller's console for negotiation">
        you are the seller
      </Chip>
      <button
        type="button"
        onClick={() => void run("accept")}
        disabled={disabled}
        className={`${buttonClass.native} py-1`}
        aria-label={`Accept offer ${offer.id} at ${price} as the seller`}
      >
        {busy === "accept" && <Spinner />}
        Accept {price}
      </button>
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (counterValid && !disabled) void run("counter");
        }}
      >
        <label className="sr-only" htmlFor={`counter-${offer.id}`}>
          Counter price in dollars for offer {offer.id}
        </label>
        <span className="text-xs text-muted" aria-hidden="true">
          $
        </span>
        <input
          id={`counter-${offer.id}`}
          type="number"
          inputMode="decimal"
          min={1}
          step="0.01"
          value={counter}
          onChange={(e) => setCounter(e.target.value)}
          disabled={disabled}
          className={`${inputClass} !w-20 !py-1 !text-xs tabular-nums`}
        />
        <button type="submit" disabled={disabled || !counterValid} className={`${buttonClass.secondary} py-1`}>
          {busy === "counter" && <Spinner />}
          Counter
        </button>
      </form>
      <button
        type="button"
        onClick={() => void run("decline")}
        disabled={disabled}
        className={`${buttonClass.secondary} py-1 text-danger`}
        aria-label={`Decline offer ${offer.id} as the seller`}
      >
        {busy === "decline" && <Spinner />}
        Decline
      </button>
      {error && (
        <p role="alert" className="basis-full font-mono text-[11px] text-danger">
          Action failed: {error}
        </p>
      )}
      <KeewanoTip offer={offer} disabled={disabled} onUseCounter={(cents) => setCounter((cents / 100).toFixed(2))} />
    </div>
  );
}

/** Live Keewano demand + counter history for this offer, with the recommended move. */
function KeewanoTip({
  offer,
  disabled,
  onUseCounter,
}: {
  offer: Offer;
  disabled: boolean;
  onUseCounter: (cents: number) => void;
}) {
  // One fetch per offer version; a result for an older version reads as loading.
  const version = versionKey(offer);
  const [result, setResult] = useState<
    | { version: string; kind: "ready"; insight: NegotiationInsight }
    | { version: string; kind: "off" }
    | { version: string; kind: "error"; message: string }
    | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    getOfferInsight(offer.id)
      .then(({ insight }) => !cancelled && setResult(insight ? { version, kind: "ready", insight } : { version, kind: "off" }))
      .catch((err) => !cancelled && setResult({ version, kind: "error", message: errorMessage(err) }));
    return () => {
      cancelled = true;
    };
  }, [offer.id, version]);

  const state = result?.version === version ? result : { kind: "loading" as const };
  if (state.kind === "off") return null;
  if (state.kind === "loading") {
    return (
      <p className="basis-full flex items-center gap-1 text-[11px] text-muted">
        <Spinner /> Asking Keewano about demand for {offer.listingId}…
      </p>
    );
  }
  if (state.kind === "error") {
    return <p className="basis-full font-mono text-[11px] text-muted">Keewano unavailable: {state.message}</p>;
  }

  const { insight } = state;
  const { advice } = insight;
  const facts = [
    insight.otherOffers24h !== null && `${insight.otherOffers24h} other offer${insight.otherOffers24h === 1 ? "" : "s"} / 24h`,
    insight.topOtherOfferCents !== null && `top ${formatCents(insight.topOtherOfferCents, insight.currency)}`,
    insight.views24h !== null && `${insight.views24h} view${insight.views24h === 1 ? "" : "s"} / 24h`,
    `offer ${insight.offerPct}% of ask`,
  ].filter(Boolean);
  return (
    <div className="basis-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px]">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Chip tone="accent" title={`Live Keewano query at ${insight.queriedAt}`}>
          Keewano
        </Chip>
        <span className="text-muted">{facts.join(" · ")}</span>
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-2">
        <span className="font-semibold">
          {advice.action === "accept"
            ? `Suggest: accept ${formatCents(advice.priceCents, insight.currency)}`
            : `Suggest: counter at ${formatCents(advice.priceCents, insight.currency)}`}
        </span>
        <span className="text-muted">({advice.reasons.join("; ")})</span>
        {advice.action === "counter" && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onUseCounter(advice.priceCents)}
            className={`${buttonClass.secondary} ml-auto py-0.5`}
          >
            Use {formatCents(advice.priceCents, insight.currency)}
          </button>
        )}
      </p>
      {insight.errors.length > 0 && (
        <p className="mt-1 font-mono text-[10px] text-muted" title={insight.errors.join("\n")}>
          {insight.errors.length} Keewano quer{insight.errors.length === 1 ? "y" : "ies"} failed; advice uses what answered.
        </p>
      )}
    </div>
  );
}

/** Accepted offer → hosted Stripe test Checkout. `paid` is shown only once the webhook has set it. */
function OrderPayment({
  offer,
  order,
  ready,
  onChanged,
}: {
  offer: Offer;
  order: Order | null;
  ready: boolean;
  onChanged: () => void;
}) {
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [processing, setProcessing] = useState(false);
  // Order id known from the last pay() even before the orders poll catches up.
  const [payingOrderId, setPayingOrderId] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);

  // Back/forward from Stripe restores this page from bfcache with `paying` still true.
  useEffect(() => {
    const onPageShow = () => setPaying(false);
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  async function pay() {
    setPaying(true);
    setError(null);
    setNotConfigured(false);
    setCheckResult(null);
    try {
      const { order: ensured } = await postOrder({ offerId: offer.id });
      setPayingOrderId(ensured.id);
      const { url } = await postCheckout(ensured.id);
      window.location.assign(url);
    } catch (err) {
      if (err instanceof ApiError && err.code === "STRIPE_NOT_CONFIGURED") setNotConfigured(true);
      else if (err instanceof ApiError && err.code === "PAYMENT_PROCESSING") setProcessing(true);
      // The server just confirmed an earlier payment with Stripe: refetch to show it as paid.
      else if (err instanceof ApiError && err.code === "ORDER_NOT_PENDING") onChanged();
      else setError(errorMessage(err));
      setPaying(false);
    }
  }

  const checkOrderId = order?.id ?? payingOrderId;
  async function checkStatus() {
    if (!checkOrderId) return;
    setChecking(true);
    setError(null);
    setNotConfigured(false);
    try {
      const result = await postConfirm(checkOrderId);
      if (result.confirmed) {
        setCheckResult(`Payment confirmed — order ${result.order.id} paid`);
        setProcessing(false);
        onChanged();
      } else {
        const detail = result.reason
          ? result.reason.replace(/_/g, " ")
          : `session ${result.sessionStatus ?? "unknown"}, payment ${result.paymentStatus ?? "unknown"}`;
        setCheckResult(`Not paid yet (${detail})`);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "STRIPE_NOT_CONFIGURED") setNotConfigured(true);
      else setError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }

  if (order?.paymentStatus === "paid") {
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
        <Chip tone="success">Paid</Chip>
        <span className="text-muted">
          Order <span className="font-mono">{order.id}</span> · {formatCents(order.amountCents)} via Stripe test checkout
        </span>
        <SellerPayout order={order} onChanged={onChanged} />
      </div>
    );
  }

  const failed = order?.paymentStatus === "failed";
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      {failed ? (
        <>
          <Chip tone="danger">Payment failed</Chip>
          <span className="text-xs text-muted">
            Order <span className="font-mono">{order.id}</span>
          </span>
        </>
      ) : (
        <p className="text-xs font-medium text-success">
          Accepted — {order ? `order ${order.id} ` : "order "}pending payment
        </p>
      )}
      {((order?.paymentStatus === "pending" && order.stripeCheckoutSessionId) || processing) && checkOrderId && (
        <button
          type="button"
          onClick={() => void checkStatus()}
          disabled={checking}
          className={`${buttonClass.secondary} ${processing ? "ml-auto" : ""}`}
          aria-label={`Check payment status of order ${checkOrderId} with Stripe`}
        >
          {checking && <Spinner />}
          Check payment status
        </button>
      )}
      {processing ? (
        <p role="status" className="text-[11px] text-muted">
          Payment received, awaiting confirmation…
        </p>
      ) : (
        ready && (
          <button
            type="button"
            onClick={() => void pay()}
            disabled={paying}
            className={`${buttonClass.native} ml-auto py-1`}
            aria-label={`${failed ? "Retry payment" : "Pay"} ${formatCents(offer.proposedPriceCents)} for offer ${offer.id} with Stripe test checkout`}
          >
            {paying && <Spinner />}
            {failed ? "Retry payment" : "Pay with Stripe (test)"}
          </button>
        )
      )}
      {checkResult && (
        <p role="status" className="basis-full text-[11px] text-muted">
          {checkResult}
        </p>
      )}
      {notConfigured && (
        <p role="status" className="basis-full text-[11px] text-muted">
          Stripe not configured (set STRIPE_SECRET_KEY)
        </p>
      )}
      {error && (
        <p role="alert" className="basis-full font-mono text-[11px] text-danger">
          Payment error: {error}
        </p>
      )}
    </div>
  );
}

/** Seller side of a paid order: the Stripe Connect test transfer to the seller's connected account. */
function SellerPayout({ order, onChanged }: { order: Order; onChanged: () => void }) {
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setRetrying(true);
    setError(null);
    try {
      const result = await postPayout(order.id);
      if (result.outcome === "failed" || result.outcome === "not_configured") setError(result.error ?? result.outcome);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRetrying(false);
    }
  }

  if (order.payoutStatus === "paid") {
    return (
      <Chip tone="success" title={order.stripeTransferId ?? undefined}>
        Seller paid {formatCents(order.payoutAmountCents ?? 0, order.payoutCurrency ?? "USD")}
      </Chip>
    );
  }
  if (order.payoutStatus === "in_progress") {
    return (
      <span role="status" className="text-[11px] text-muted">
        Seller payout in progress…
      </span>
    );
  }

  const status =
    order.payoutStatus === "failed" ? (
      <Chip tone="danger" title={order.payoutError ?? undefined}>
        Seller payout failed
      </Chip>
    ) : order.payoutStatus === "not_configured" ? (
      <span role="status" className="text-[11px] text-muted" title={order.payoutError ?? undefined}>
        Seller payout: enable Stripe Connect
      </span>
    ) : (
      <span className="text-[11px] text-muted">Seller payout pending</span>
    );
  return (
    <>
      {status}
      <button
        type="button"
        onClick={() => void retry()}
        disabled={retrying}
        className={buttonClass.secondary}
        aria-label={`Retry the seller payout for order ${order.id}`}
      >
        {retrying && <Spinner />}
        Retry payout
      </button>
      {error && (
        <p role="alert" className="basis-full font-mono text-[11px] text-danger">
          Payout error: {error}
        </p>
      )}
    </>
  );
}
