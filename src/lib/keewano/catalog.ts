/**
 * PingMarket's Keewano custom-event catalog (pure, no I/O).
 *
 * APPEND-ONLY: a registered event's type can never change. To change one, add a new event with a new id.
 * The catalog's hash is derived from its content, so appending registers a new map automatically.
 *
 * Entities (Keewano keeps one ordered timeline per entity):
 * - offer:   one timeline per negotiation (Offer* / Counter* / Advice* / Order Paid Cents)
 * - listing: views and asks (Listing*)
 * - search:  one per buyer search (Search*)
 */

export type KeewanoDataType = "none" | "string" | "uint" | "bool" | "timestamp" | "price_usd_cent";

export const KEEWANO_EVENTS = {
  "Offer Listing": { id: 2000, type: "string" },
  "Offer Listing Key": { id: 2001, type: "string" },
  "Offer Marketplace": { id: 2002, type: "string" },
  "Offer Source": { id: 2003, type: "string" },
  "Offer Ask Cents": { id: 2004, type: "uint" },
  "Offer Pct Of Ask": { id: 2005, type: "uint" },
  "Offer Band": { id: 2006, type: "string" },
  "Offer Made Cents": { id: 2007, type: "uint" },
  "Counter Band": { id: 2008, type: "string" },
  "Counter Cents": { id: 2009, type: "uint" },
  /** Payload: who accepted, `seller` | `buyer`. */
  "Offer Accepted": { id: 2010, type: "string" },
  /** Payload: who declined, `seller` | `buyer`. Competing offers closed by an accept are `Offer Superseded`. */
  "Offer Declined": { id: 2011, type: "string" },
  "Order Paid Cents": { id: 2012, type: "uint" },
  "Listing Key": { id: 2013, type: "string" },
  "Listing Marketplace": { id: 2014, type: "string" },
  "Listing Ask Cents": { id: 2015, type: "uint" },
  /** Payload: channel, `sms` | `sim`. */
  "Listing Viewed": { id: 2016, type: "string" },
  "Search Marketplace": { id: 2017, type: "string" },
  "Search Native Results": { id: 2018, type: "uint" },
  "Search Darwin Status": { id: 2019, type: "string" },
  "Search External Results": { id: 2020, type: "uint" },
  /** Payload: what PingMarket advised the seller, `accept` | `counter`. */
  "Negotiation Advice": { id: 2021, type: "string" },
  "Advice Price Cents": { id: 2022, type: "uint" },
  "Offer Superseded": { id: 2023, type: "none" },
  "Offer Key": { id: 2024, type: "string" },
} as const satisfies Record<string, { id: number; type: KeewanoDataType }>;

export type KeewanoEventName = keyof typeof KEEWANO_EVENTS;

export interface KeewanoEvent {
  name: KeewanoEventName;
  /** Omit for `none` events. Strings are capped at 256 chars by Keewano. */
  value?: string | number | boolean;
  /** Unix seconds; defaults to now. Only backfills set it. */
  timestamp?: number;
}

export const KEEWANO_EVENT_TYPES = Object.entries(KEEWANO_EVENTS).map(([name, e]) => ({
  eventTypeId: e.id,
  name,
  dataType: e.type,
}));

/** FNV-1a over the catalog JSON: changes whenever the catalog does. Never 0 (reserved for "no custom events"). */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0 || 1;
}

export const KEEWANO_EVENTS_HASH = fnv1a(JSON.stringify(KEEWANO_EVENT_TYPES));

/** Offer price as a share of the ask, in 10-point bands: `<50`, `50-59` … `90-99`, `100+`. */
export function pctBand(pct: number): string {
  if (pct >= 100) return "100+";
  if (pct < 50) return "<50";
  const lo = Math.floor(pct / 10) * 10;
  return `${lo}-${lo + 9}`;
}

/** Lower bound of a band from `pctBand` (`<50` → 0). */
export function bandLowerBound(band: string): number {
  if (band === "<50") return 0;
  const n = Number.parseInt(band, 10);
  return Number.isFinite(n) ? n : 0;
}

export function pctOfAsk(priceCents: number, askCents: number): number {
  return askCents > 0 ? Math.round((priceCents / askCents) * 100) : 0;
}

/**
 * Stable keys that survive a local database reset: human ids like `D2` / `O7` restart from 1 after
 * `.pglite` is deleted, so the row's creation time disambiguates them.
 */
export function listingKey(listing: { id: string; createdAt: string }): string {
  return `${listing.id}:${Math.floor(Date.parse(listing.createdAt) / 1000)}`;
}

export function offerKey(offer: { id: string; createdAt: string }): string {
  return `${offer.id}:${Math.floor(Date.parse(offer.createdAt) / 1000)}`;
}
