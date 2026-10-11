/**
 * Demo activity trace (PM-09): a newest-first union of messages, listings, searches, offers and orders.
 * Phone numbers are masked to their last 4 digits.
 */
import { desc, eq } from "drizzle-orm";
import { getDb, type Db } from "../db";
import { agentSearches, listings, marketplaces, messages, offers, orders } from "../db/schema";
import type { TraceEvent } from "./types";

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `…${digits.slice(-4)}` : phone;
}

export function formatMoney(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
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
      .select({ order: orders, listingId: listings.id, listingStatus: listings.status, listingUpdatedAt: listings.updatedAt })
      .from(orders)
      .leftJoin(offers, eq(orders.offerId, offers.id))
      .leftJoin(listings, eq(offers.listingId, listings.id))
      .orderBy(desc(orders.createdAt))
      .limit(limit),
  ]);

  const events: TraceEvent[] = [
    ...messageRows.map(
      (m): TraceEvent => ({
        id: `message:${m.id}`,
        at: m.createdAt.toISOString(),
        kind: m.direction === "inbound" ? "sms_inbound" : "sms_outbound",
        // `sim_` rows come from the /sim handsets (src/lib/sms/simulator.ts), never from Dial.
        summary: `${m.dialEventId.startsWith("sim_") ? "SIM " : ""}${maskPhone(m.fromNumber)} → ${maskPhone(m.toNumber)}: ${truncate(m.body, 120)}`,
        detail: { messageId: m.id, dialEventId: m.dialEventId, direction: m.direction, simulated: m.dialEventId.startsWith("sim_") },
      }),
    ),
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
    ...orderRows.flatMap(({ order: o, listingId, listingStatus, listingUpdatedAt }): TraceEvent[] => {
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
      // orders has no updated_at; a paid order marks its listing `sold` in the same transaction,
      // so the listing's updated_at is the payment time.
      const paidAt = o.paymentStatus === "paid" && listingStatus === "sold" && listingUpdatedAt ? listingUpdatedAt : o.createdAt;
      return [
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
    }),
  ];

  return events
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id, "en", { numeric: true }))
    .slice(0, limit);
}
