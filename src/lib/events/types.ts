/**
 * Demo activity trace, served by `GET /api/events?limit=50` as `{ events: TraceEvent[] }`
 * (newest first). Rendered by the dashboard's event trace panel.
 */

export const TRACE_EVENT_KINDS = [
  "sms_inbound",
  "sms_outbound",
  "listing_created",
  "search",
  "darwin_search",
  "offer",
  "order_created",
  "payment",
  "payout",
] as const;

export type TraceEventKind = (typeof TRACE_EVENT_KINDS)[number];

export interface TraceEvent {
  id: string;
  /** ISO-8601 timestamp. */
  at: string;
  kind: TraceEventKind;
  /** One human-readable line, e.g. `SMS in from +1… : SELL oak desk, $120`. */
  summary: string;
  /** Optional structured payload, shown as JSON in the dashboard. */
  detail?: Record<string, unknown>;
}
