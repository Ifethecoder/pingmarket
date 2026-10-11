/**
 * Demo activity trace (PM-09): a newest-first union of messages, listings, searches and offers.
 * Phone numbers are masked to their last 4 digits.
 */
import { desc, eq } from "drizzle-orm";
import { getDb, type Db } from "../db";
import { agentSearches, listings, marketplaces, messages, offers } from "../db/schema";
import type { TraceEvent } from "./types";

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `…${digits.slice(-4)}` : phone;
}

export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export async function listTraceEvents(limit = 50, db?: Db): Promise<TraceEvent[]> {
  const conn = db ?? (await getDb());
  const [messageRows, listingRows, searchRows, offerRows] = await Promise.all([
    conn.select().from(messages).orderBy(desc(messages.createdAt)).limit(limit),
    conn
      .select({ listing: listings, marketplaceName: marketplaces.name })
      .from(listings)
      .leftJoin(marketplaces, eq(listings.marketplaceId, marketplaces.id))
      .orderBy(desc(listings.createdAt))
      .limit(limit),
    conn.select().from(agentSearches).orderBy(desc(agentSearches.createdAt)).limit(limit),
    conn.select().from(offers).orderBy(desc(offers.updatedAt)).limit(limit),
  ]);

  const events: TraceEvent[] = [
    ...messageRows.map(
      (m): TraceEvent => ({
        id: `message:${m.id}`,
        at: m.createdAt.toISOString(),
        kind: m.direction === "inbound" ? "sms_inbound" : "sms_outbound",
        summary: `${maskPhone(m.fromNumber)} → ${maskPhone(m.toNumber)}: ${truncate(m.body, 120)}`,
        detail: { messageId: m.id, dialEventId: m.dialEventId, direction: m.direction },
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
      return {
        id: `search:${s.id}`,
        at: s.createdAt.toISOString(),
        kind: s.status === "skipped" ? "search" : "darwin_search",
        summary: `Search "${truncate(s.query, 120)}" → Darwin ${s.status}, ${nativeCount} native`,
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
  ];

  return events
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id, "en", { numeric: true }))
    .slice(0, limit);
}
