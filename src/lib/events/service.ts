/**
 * Demo activity trace (PM-09): a newest-first union of messages, listings, searches, offers and orders.
 * Phone numbers are masked to their last 4 digits.
 */
import { desc, eq } from "drizzle-orm";
import { getDb, type Db } from "../db";
import { agentSearches, listings, marketplaces, messages, offers, orders, users } from "../db/schema";
import type { TraceEvent } from "./types";

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `…${digits.slice(-4)}` : phone;
}

/** Minor units -> money; zero-decimal currencies (JPY, KRW, …) are not divided by 100. */
export function formatMoney(cents: number, currency = "USD"): string {
  try {
    const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() });
    return fmt.format(cents / 10 ** (fmt.resolvedOptions().maximumFractionDigits ?? 2));
  } catch {
    // Invalid currency code in the row: never let one bad listing break the trace feed.
    return `$${(cents / 100).toFixed(2)}`;
  }
}

export async function listTraceEvents(limit = 50, db?: Db): Promise<TraceEvent[]> {
  const conn = db ?? (await getDb());
  const [messageRows, listingRows, searchRows, offerRows, orderRows] = await Promise.all([
    conn.select().from(messages).orderBy(desc(messages.createdAt)).limit(limit),
    conn
      .select({ listing: listings, marketplaceName: marketplaces.name })
      .from(listings)
      .leftJoin(marketplaces, eq(listings.marketplaceId, marketplaces.id))
      .orderBy(desc(listings.createdAt))
      .limit(limit),
    conn.select().from(agentSearches).orderBy(desc(agentSearches.createdAt)).limit(limit),
    conn.select().from(offers).orderBy(desc(offers.updatedAt)).limit(limit),
    conn
      .select({
        order: orders,
        listingId: listings.id,
        listingStatus: listings.status,
        listingUpdatedAt: listings.updatedAt,
        sellerId: offers.sellerId,
        sellerAccountId: users.stripeAccountId,
      })
      .from(orders)
      .leftJoin(offers, eq(orders.offerId, offers.id))
      .leftJoin(listings, eq(offers.listingId, listings.id))
      .leftJoin(users, eq(offers.sellerId, users.id))
      .orderBy(desc(orders.createdAt))
      .limit(limit),
  ]);

  const events: TraceEvent[] = [
    ...messageRows.map((m): TraceEvent => {
      // `sim_` rows come from the /sim handsets (src/lib/sms/simulator.ts) and `dev_` rows from the local
      // /api/dial/simulate-inbound helper; everything else is the real phone over Dial
      // (src/lib/sms/inbound.ts / outbound.ts).
      const simulated = m.dialEventId.startsWith("sim_") || m.dialEventId.startsWith("dev_");
      return {
        id: `message:${m.id}`,
        at: m.createdAt.toISOString(),
        kind: m.direction === "inbound" ? "sms_inbound" : "sms_outbound",
        summary: `${simulated ? "SIM" : "SMS"} ${maskPhone(m.fromNumber)} → ${maskPhone(m.toNumber)}: ${truncate(m.body, 120)}`,
        detail: {
          messageId: m.id,
          dialEventId: m.dialEventId,
          direction: m.direction,
          channel: simulated ? "sim" : "dial",
          simulated,
        },
      };
    }),
    ...listingRows.map(
      ({ listing: l, marketplaceName }): TraceEvent => ({
        id: `listing:${l.id}`,
        at: l.createdAt.toISOString(),
        kind: "listing_created",
        summary: `Listing ${l.id} created: ${l.title} — ${formatMoney(l.priceCents, l.currency)} (${marketplaceName ?? l.marketplaceId})`,
        detail: {
          listingId: l.id,
          marketplaceId: l.marketplaceId,
          priceCents: l.priceCents,
          location: l.location,
          status: l.status,
          visibility: l.visibility,
        },
      }),
    ),
    ...searchRows.map((s): TraceEvent => {
      const nativeCount = Number(s.resultMetadata.nativeCount ?? 0);
      const followUp = typeof s.resultMetadata.previousResponseId === "string";
      // Explicit field list: `darwin_search_token` must never reach the trace.
      return {
        id: `search:${s.id}`,
        at: s.createdAt.toISOString(),
        kind: s.status === "skipped" ? "search" : "darwin_search",
        summary: `${followUp ? "Follow-up" : "Search"} "${truncate(s.query, 120)}" → Darwin ${s.status}, ${nativeCount} native`,
        detail: {
          searchId: s.id,
          darwinSearchId: s.darwinSearchId,
          darwinResponseId: s.darwinResponseId,
          ...s.resultMetadata,
        },
      };
    }),
    ...offerRows.map(
      (o): TraceEvent => ({
        id: `offer:${o.id}`,
        at: o.updatedAt.toISOString(),
        kind: "offer",
        summary: `Offer ${o.id}: ${formatMoney(o.proposedPriceCents)} for ${o.listingId} — ${o.status} (${o.source})`,
        detail: {
          offerId: o.id,
          listingId: o.listingId,
          proposedPriceCents: o.proposedPriceCents,
          status: o.status,
          source: o.source,
          lastActorId: o.lastActorId,
        },
      }),
    ),
    ...orderRows.flatMap(
      ({ order: o, listingId, listingStatus, listingUpdatedAt, sellerId, sellerAccountId }): TraceEvent[] => {
        const detail = {
          orderId: o.id,
          offerId: o.offerId,
          listingId,
          amountCents: o.amountCents,
          paymentStatus: o.paymentStatus,
          stripeCheckoutSessionId: o.stripeCheckoutSessionId,
        };
        const created: TraceEvent = {
          id: `order:${o.id}`,
          at: o.createdAt.toISOString(),
          kind: "order_created",
          summary: `Order ${o.id} created for offer ${o.offerId} · ${formatMoney(o.amountCents)} pending`,
          detail,
        };
        if (o.paymentStatus === "pending") return [created];
        // `paid_at` is set with the payment; older rows fall back to the sold listing's updated_at
        // (set in the same transaction), then to the order's creation time.
        const paidAt =
          o.paidAt ??
          (o.paymentStatus === "paid" && listingStatus === "sold" && listingUpdatedAt ? listingUpdatedAt : o.createdAt);
        const events: TraceEvent[] = [
          created,
          {
            id: `payment:${o.id}`,
            at: paidAt.toISOString(),
            kind: "payment",
            summary:
              o.paymentStatus === "paid"
                ? `Order ${o.id} paid via Stripe test checkout · ${formatMoney(o.amountCents)}`
                : `Order ${o.id} payment failed (Stripe test checkout)`,
            detail,
          },
        ];
        if (o.payoutStatus === "not_started") return events;
        const account = sellerAccountId ? ` (acct_…${sellerAccountId.slice(-4)})` : "";
        const reason = truncate(o.payoutError ?? "unknown error", 120);
        const summary =
          o.payoutStatus === "paid"
            ? `Seller payout ${formatMoney(o.payoutAmountCents ?? 0, o.payoutCurrency ?? "USD")} → ${sellerId ?? "seller"}${account} for ${o.id}`
            : o.payoutStatus === "in_progress"
              ? `Seller payout in progress for ${o.id}`
              : o.payoutStatus === "failed"
                ? `Seller payout failed for ${o.id}: ${reason}`
                : `Seller payout not configured for ${o.id}: ${reason}`;
        events.push({
          id: `payout:${o.id}`,
          at: (o.payoutStatus === "in_progress" ? (o.payoutClaimedAt ?? paidAt) : (o.payoutAt ?? paidAt)).toISOString(),
          kind: "payout",
          summary,
          detail: {
            orderId: o.id,
            sellerId,
            stripeAccountId: sellerAccountId,
            payoutStatus: o.payoutStatus,
            payoutAmountCents: o.payoutAmountCents,
            platformFeeCents: o.platformFeeCents,
            payoutCurrency: o.payoutCurrency,
            stripeTransferId: o.stripeTransferId,
            payoutError: o.payoutError,
          },
        });
        return events;
      },
    ),
  ];

  return events
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id, "en", { numeric: true }))
    .slice(0, limit);
}
