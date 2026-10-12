/**
 * Drizzle schema for PingMarket (PRD §8 "Database tables").
 * DB columns are snake_case; TS fields are camelCase. Enum-like columns are `text` typed via `$type`.
 * Regenerate SQL migrations with `npm run db:generate` after changing this file.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type {
  ConsentStatus,
  ListingStatus,
  ListingVisibility,
  MarketplaceId,
  MessageDirection,
  OfferSource,
  OfferStatus,
  PaymentStatus,
  PayoutStatus,
  UserRole,
} from "../types";

/** Mints human listing ids `D{n}`. Seed uses fixed D1..D8 and bumps this past them. */
export const listingIdSeq = pgSequence("listing_id_seq");
/** Mints human offer ids `O{n}`. */
export const offerIdSeq = pgSequence("offer_id_seq");
/** Mints order ids `ORD{n}`. */
export const orderIdSeq = pgSequence("order_id_seq");

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const marketplaces = pgTable("marketplaces", {
  id: text("id").$type<MarketplaceId>().primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  dialNumber: text("dial_number"),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  phone: text("phone").unique(),
  role: text("role").$type<UserRole>().notNull(),
  consentStatus: text("consent_status")
    .$type<ConsentStatus>()
    .notNull()
    .default("unknown"),
  /** Stripe Connect test connected account (`acct_…`) that receives seller payouts. */
  stripeAccountId: text("stripe_account_id").unique(),
  createdAt: createdAt(),
});

export const listings = pgTable(
  "listings",
  {
    id: text("id").primaryKey(),
    marketplaceId: text("marketplace_id")
      .$type<MarketplaceId>()
      .notNull()
      .references(() => marketplaces.id),
    sellerId: text("seller_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    description: text("description"),
    priceCents: integer("price_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    location: text("location"),
    status: text("status").$type<ListingStatus>().notNull().default("available"),
    visibility: text("visibility")
      .$type<ListingVisibility>()
      .notNull()
      .default("cross_market"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("listings_marketplace_id_idx").on(t.marketplaceId),
    index("listings_status_idx").on(t.status),
  ],
);

export const interests = pgTable("interests", {
  id: text("id").primaryKey(),
  buyerId: text("buyer_id")
    .notNull()
    .references(() => users.id),
  query: text("query").notNull(),
  maxPriceCents: integer("max_price_cents"),
  location: text("location"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
});

export const offers = pgTable(
  "offers",
  {
    id: text("id").primaryKey(),
    listingId: text("listing_id")
      .notNull()
      .references(() => listings.id),
    buyerId: text("buyer_id")
      .notNull()
      .references(() => users.id),
    sellerId: text("seller_id")
      .notNull()
      .references(() => users.id),
    proposedPriceCents: integer("proposed_price_cents").notNull(),
    status: text("status").$type<OfferStatus>().notNull().default("open"),
    lastActorId: text("last_actor_id").notNull(),
    source: text("source").$type<OfferSource>().notNull().default("web_simulated"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("offers_listing_id_idx").on(t.listingId)],
);

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  dialEventId: text("dial_event_id").notNull().unique(),
  fromNumber: text("from_number").notNull(),
  toNumber: text("to_number").notNull(),
  body: text("body").notNull(),
  direction: text("direction").$type<MessageDirection>().notNull(),
  createdAt: createdAt(),
});

export const orders = pgTable("orders", {
  id: text("id").primaryKey(),
  offerId: text("offer_id")
    .notNull()
    .unique()
    .references(() => offers.id),
  amountCents: integer("amount_cents").notNull(),
  paymentStatus: text("payment_status")
    .$type<PaymentStatus>()
    .notNull()
    .default("pending"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  /** When the payment was confirmed (set together with `payment_status = 'paid'`). */
  paidAt: timestamp("paid_at", { withTimezone: true }),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  /** Seller payout via Stripe Connect transfer (separate charges and transfers, test mode). */
  payoutStatus: text("payout_status").$type<PayoutStatus>().notNull().default("not_started"),
  stripeTransferId: text("stripe_transfer_id"),
  /** Transfer amount / platform fee in minor units of `payout_currency` (the platform's settlement currency). */
  payoutAmountCents: integer("payout_amount_cents"),
  platformFeeCents: integer("platform_fee_cents"),
  /** Lowercase ISO currency of the transfer, e.g. `jpy` (zero-decimal) or `usd`. */
  payoutCurrency: text("payout_currency"),
  /** Short `type:code message` of the last failed payout attempt; never a raw Stripe payload. */
  payoutError: text("payout_error"),
  /** Failed transfer attempts so far; part of the transfer idempotency key so a retry is a new request. */
  payoutAttempts: integer("payout_attempts").notNull().default(0),
  /** Time of the last payout outcome (paid / failed / not_configured). */
  payoutAt: timestamp("payout_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const agentSearches = pgTable("agent_searches", {
  id: text("id").primaryKey(),
  query: text("query").notNull(),
  darwinSearchId: text("darwin_search_id"),
  darwinResponseId: text("darwin_response_id"),
  /** Private Darwin continuation token (X-Search-Token for follow-ups). Never exposed via API or trace. */
  darwinSearchToken: text("darwin_search_token"),
  status: text("status").notNull(),
  resultMetadata: jsonb("result_metadata")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: createdAt(),
});

export type ListingRow = typeof listings.$inferSelect;
export type OfferRow = typeof offers.$inferSelect;
