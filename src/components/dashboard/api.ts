import type {
  CreateOfferRequest,
  Listing,
  Marketplace,
  Offer,
  SearchRequest,
  SearchResponse,
} from "@/lib/types";
import type { TraceEvent } from "@/lib/events/types";

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
  });
