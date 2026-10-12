/**
 * PingMarket shared types — FROZEN contract between Developer A (Dial/SMS/negotiation)
 * and Developer B (Darwin/data/search/dashboard).
 *
 * Changing any exported shape here requires coordination with the other workstream.
 * Wire-level validation of the HTTP contract lives in `src/lib/contracts.ts` (zod).
 */

export const MARKETPLACE_IDS = ["furniture", "creative"] as const;
export type MarketplaceId = (typeof MARKETPLACE_IDS)[number];

export type ListingStatus = "available" | "reserved" | "sold" | "removed";
/** `cross_market`: discoverable from any marketplace search. `marketplace_only`: own marketplace only. */
export type ListingVisibility = "cross_market" | "marketplace_only";

export type UserRole = "buyer" | "seller" | "operator";
export type ConsentStatus = "unknown" | "opted_in" | "opted_out";

export type OfferStatus = "open" | "countered" | "accepted" | "declined" | "expired";
/** Where the offer originated. `web_simulated` = demo dashboard buyer, never a real third phone. */
export type OfferSource = "sms" | "web_simulated";

export type PaymentStatus = "pending" | "paid" | "failed";
/** Seller payout (Stripe Connect test transfer). `not_configured` = Connect not enabled on the platform. */
export type PayoutStatus = "not_started" | "not_configured" | "paid" | "failed";
export type MessageDirection = "inbound" | "outbound";

export interface Marketplace {
  id: MarketplaceId;
  name: string;
  category: string;
  dialNumber: string | null;
}

export interface User {
  id: string;
  phone: string | null;
  role: UserRole;
  consentStatus: ConsentStatus;
}

export interface Listing {
  /** Human-facing id used in SMS, e.g. `D42`. */
  id: string;
  marketplaceId: MarketplaceId;
  sellerId: string;
  title: string;
  description: string | null;
  /** Positive integer cents. */
  priceCents: number;
  currency: string;
  location: string | null;
  status: ListingStatus;
  visibility: ListingVisibility;
  createdAt: string;
}

export interface Offer {
  /** Human-facing id used in SMS, e.g. `O7`. */
  id: string;
  listingId: string;
  buyerId: string;
  sellerId: string;
  /** Current proposed price (buyer's offer, or seller's latest counter). Positive integer cents. */
  proposedPriceCents: number;
  status: OfferStatus;
  lastActorId: string;
  source: OfferSource;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Order {
  id: string;
  offerId: string;
  amountCents: number;
  paymentStatus: PaymentStatus;
  stripeCheckoutSessionId: string | null;
  paidAt: string | null;
  stripePaymentIntentId: string | null;
  payoutStatus: PayoutStatus;
  stripeTransferId: string | null;
  /** Minor units of `payoutCurrency` (the platform's settlement currency; JPY has no decimals). */
  payoutAmountCents: number | null;
  platformFeeCents: number | null;
  payoutCurrency: string | null;
  payoutError: string | null;
  payoutAt: string | null;
  createdAt: string;
}

export interface Message {
  id: string;
  dialEventId: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  direction: MessageDirection;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// POST /api/search contract
// ---------------------------------------------------------------------------

export interface SearchRequest {
  query: string;
  /** Marketplace the buyer is browsing from. Cross-market listings from other marketplaces are still returned. */
  marketplaceId?: MarketplaceId;
  maxPriceCents?: number;
  location?: string;
  /** Default true. When false the Darwin call is skipped and `darwin.status` is `skipped`. */
  includeExternalAgents?: boolean;
  /**
   * Darwin `responseId` from an earlier PingMarket search response (`darwin.responseId`). Continues that
   * Darwin conversation: answer a `needs_input` question or refine the results. Darwin treats the new
   * `query` as the current task ("latest task wins"), so send a complete request, not a bare answer.
   * Requires `includeExternalAgents` to be true (the default). Native listings are searched with the new query.
   */
  previousResponseId?: string;
}

export interface NativeListingResult {
  type: "native_listing";
  id: string;
  marketplaceId: MarketplaceId;
  title: string;
  description: string | null;
  priceCents: number;
  currency: string;
  location: string | null;
  status: ListingStatus;
  /** True when the listing lives in a different marketplace than the one searched from. */
  crossMarket: boolean;
  /** Why this listing matched (token hits, price fit, location). Deterministic, not an LLM output. */
  matchReasons: string[];
}

export type DarwinReadiness =
  | "ready"
  | "authentication_required"
  | "recheck_required"
  | "unavailable";

export interface DarwinConnectionMethod {
  protocol: "MCP" | "A2A" | "WEBMCP" | string;
  environment: string | null;
  endpointUrl: string | null;
  endpointStatus: string | null;
  documentationUrl: string | null;
}

export interface DarwinRequiredSetup {
  kind: string;
  suppliedBy: string | null;
  description: string | null;
}

/**
 * An external capability discovered via Darwin Search.
 * This is NOT inventory, NOT a quote, and NOT a confirmation that the provider can do the task.
 * All ids/revisions are copied verbatim from Darwin.
 */
export interface DarwinCapabilityResult {
  type: "darwin_capability";
  agentId: string;
  agentSlug: string | null;
  capabilityId: string;
  capabilityRevision: number | null;
  rank: number;
  name: string;
  description: string | null;
  readiness: DarwinReadiness;
  canStartThread: boolean;
  canAttemptThread: boolean;
  providerCheck: string | null;
  reasons: string[];
  uncertainties: string[];
  /** `null` means "no setup declared" — unknown, not "none needed". */
  requiredSetup: DarwinRequiredSetup | null;
  connectionMethods: DarwinConnectionMethod[];
  connectionPrompt: string | null;
  /** Darwin index page for this agent+capability, built from the exact ids above. */
  agentPageUrl: string;
}

export type DarwinSearchStatus =
  | "completed"
  | "needs_input"
  | "no_match"
  /** Darwin was not called (includeExternalAgents=false). */
  | "skipped"
  /** Darwin call failed (network/5xx/timeout). Never show as "no agents exist". */
  | "error";

/** A refinement Darwin suggests; send `query` as a follow-up (`previousResponseId`). */
export interface DarwinRelatedSearch {
  query: string;
  reason: string | null;
}

export interface DarwinSearchOutcome {
  status: DarwinSearchStatus;
  searchId: string | null;
  /** Send this back as `SearchRequest.previousResponseId` to follow up. */
  responseId: string | null;
  /** Set when this outcome continued an earlier Darwin response (a follow-up). */
  previousResponseId: string | null;
  relatedSearches: DarwinRelatedSearch[];
  /** Present when status is `needs_input`: ask the buyer this. */
  question: string | null;
  /** Present when status is `no_match`. */
  noMatchReason: string | null;
  overview: string | null;
  assessment: { outcome: string; explanation: string } | null;
  error: string | null;
  latencyMs: number | null;
}

export interface SearchResponse {
  query: string;
  marketplaceId: MarketplaceId | null;
  nativeListings: NativeListingResult[];
  externalCapabilities: DarwinCapabilityResult[];
  darwin: DarwinSearchOutcome;
}

// ---------------------------------------------------------------------------
// Offer contract (POST /api/offers). State transitions are owned by Developer A
// (`src/lib/negotiation/service.ts` + /api/offers/{id}/counter|accept|decline).
// ---------------------------------------------------------------------------

export interface CreateOfferRequest {
  listingId: string;
  /** Positive integer cents. */
  priceCents: number;
  /**
   * Buyer identity. Omit for the web demo buyer (seeded user `u_web_buyer`, source `web_simulated`).
   * Developer A's SMS router passes the mapped SMS user id with source `sms`.
   */
  buyerId?: string;
  source?: OfferSource;
}

export interface CreateListingInput {
  sellerId: string;
  marketplaceId: MarketplaceId;
  title: string;
  description?: string | null;
  priceCents: number;
  currency?: string;
  location?: string | null;
  visibility?: ListingVisibility;
}
