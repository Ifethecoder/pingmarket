import type {
  CreateOfferRequest,
  Listing,
  Marketplace,
  MarketplaceId,
  Message,
  Offer,
  Order,
  SearchRequest,
  SearchResponse,
} from "@/lib/types";
import type { TraceEvent } from "@/lib/events/types";
import type { DarwinActView } from "@/lib/darwin/act";
import type { NegotiationInsight } from "@/lib/keewano/insight";

/** Error thrown by `apiFetch`; `message` is the server's `error` text or `HTTP {status}`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly issues: unknown;

  constructor(message: string, status: number, code: string | null = null, issues: unknown = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSON fetch against the PingMarket API. Never cached. Throws `ApiError` on non-2xx
 * (using the server's `{ error, code, issues }` envelope when present) or non-JSON bodies.
 */
export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(url, { cache: "no-store", ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const fallback = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
    if (isRecord(body)) {
      const message = typeof body.error === "string" && body.error ? body.error : fallback;
      const code = typeof body.code === "string" ? body.code : null;
      throw new ApiError(message, res.status, code, body.issues);
    }
    throw new ApiError(fallback, res.status);
  }

  if (body === null) {
    throw new ApiError(`HTTP ${res.status}: response was not JSON`, res.status);
  }
  return body as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Typed endpoint wrappers (shapes from src/lib/types.ts + src/lib/events/types.ts)
// ---------------------------------------------------------------------------

export const getMarketplaces = () =>
  apiFetch<{ marketplaces: Marketplace[] }>("/api/marketplaces");

export const getListings = () => apiFetch<{ listings: Listing[] }>("/api/listings");

export const getOffers = () => apiFetch<{ offers: Offer[] }>("/api/offers");

export const getEvents = (limit = 50) =>
  apiFetch<{ events: TraceEvent[] }>(`/api/events?limit=${limit}`);

export const postSearch = (body: SearchRequest) =>
  apiFetch<SearchResponse>("/api/search", { method: "POST", body: JSON.stringify(body) });

/** `buyerId` is intentionally omitted: the server maps the web demo buyer (`web_simulated`). */
export const postOffer = (body: Pick<CreateOfferRequest, "listingId" | "priceCents">) =>
  apiFetch<{ offer: Offer }>("/api/offers", { method: "POST", body: JSON.stringify(body) });

export const acceptOffer = (offerId: string) =>
  apiFetch<{ offer: Offer }>(`/api/offers/${encodeURIComponent(offerId)}/accept`, {
    method: "POST",
    // JSON body so apiFetch sends content-type application/json (the route's CSRF guard requires it).
    body: JSON.stringify({}),
  });

/** Live Keewano recommendation for an offer awaiting the seller; `insight: null` when Keewano is not configured. */
export const getOfferInsight = (offerId: string) =>
  apiFetch<{ insight: NegotiationInsight | null; code?: string }>(`/api/offers/${encodeURIComponent(offerId)}/insight`);

export const counterOffer = (offerId: string, priceCents: number) =>
  apiFetch<{ offer: Offer }>(`/api/offers/${encodeURIComponent(offerId)}/counter`, {
    method: "POST",
    body: JSON.stringify({ priceCents }),
  });

export const declineOffer = (offerId: string) =>
  apiFetch<{ offer: Offer }>(`/api/offers/${encodeURIComponent(offerId)}/decline`, {
    method: "POST",
    // JSON body so apiFetch sends content-type application/json (the route's CSRF guard requires it).
    body: JSON.stringify({}),
  });

export const getOrders = () => apiFetch<{ orders: Order[] }>("/api/orders");

/** Get-or-create the order for an accepted offer (201 created, 200 existing). */
export const postOrder = (body: { offerId: string }) =>
  apiFetch<{ order: Order }>("/api/orders", { method: "POST", body: JSON.stringify(body) });

/** Hosted Stripe test-mode Checkout URL. Never marks the order paid; only the signed webhook does. */
export const postCheckout = (orderId: string) =>
  apiFetch<{ url: string; sessionId: string }>(`/api/orders/${encodeURIComponent(orderId)}/checkout`, {
    method: "POST",
  });

// ---------------------------------------------------------------------------
// Simulated SMS handsets (/sim). Shapes from src/lib/sms/simulator.ts.
// ---------------------------------------------------------------------------

export type SimActor = "seller" | "buyer";

export interface SimHandset {
  actor: SimActor;
  userId: string;
  number: string;
}

export interface SimThread {
  handset: SimHandset;
  serviceNumber: string;
  messages: Message[];
}

export const getSimThread = (actor: SimActor) => apiFetch<SimThread>(`/api/sms/simulate?actor=${actor}`);

export const postSimSms = (body: { actor: SimActor; body: string; marketplaceId?: MarketplaceId }) =>
  apiFetch<{ inbound: Message; outbound: Message[] }>("/api/sms/simulate", {
    method: "POST",
    body: JSON.stringify(body),
  });

export interface ConfirmPaymentResponse {
  order: Order;
  confirmed: boolean;
  sessionStatus: string | null;
  paymentStatus: string | null;
  reason?: string;
}

/** Server reads the Checkout Session from Stripe (secret key) and marks the order paid only if Stripe says so. */
export const postConfirm = (orderId: string, sessionId?: string) =>
  apiFetch<ConfirmPaymentResponse>(`/api/orders/${encodeURIComponent(orderId)}/confirm`, {
    method: "POST",
    body: JSON.stringify(sessionId ? { sessionId } : {}),
  });

// ---------------------------------------------------------------------------
// Darwin Act (beta): one text message to an agent from a stored search, then poll its thread.
// ---------------------------------------------------------------------------

export const postDarwinAct = (body: { searchId: string; agentId: string; capabilityId: string; message: string }) =>
  apiFetch<DarwinActView>("/api/darwin/act", { method: "POST", body: JSON.stringify(body) });

export const getDarwinAct = (actRequestId: string) =>
  apiFetch<DarwinActView>(`/api/darwin/act/${encodeURIComponent(actRequestId)}`);

export interface PayoutResponse {
  order: Order;
  outcome: "paid" | "already_paid" | "not_configured" | "failed";
  transferId: string | null;
  error?: string;
}

/** Retries the seller payout (Stripe Connect test transfer) for a paid order. */
export const postPayout = (orderId: string) =>
  apiFetch<PayoutResponse>(`/api/orders/${encodeURIComponent(orderId)}/payout`, { method: "POST" });
