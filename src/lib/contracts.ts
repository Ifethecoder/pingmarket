/**
 * Zod schemas for the HTTP contract (frozen; see src/lib/types.ts for the TS shapes).
 * Route handlers validate request bodies with these; services receive typed values.
 */
import { z } from "zod";
import { MARKETPLACE_IDS } from "./types";

/** Upper bound for integer cents columns (Postgres `integer`). */
export const MAX_PRICE_CENTS = 2_147_483_647;

export const marketplaceIdSchema = z.enum(MARKETPLACE_IDS);

/** Darwin Search v3 `responseId` format (`sresp_<uuid>`). */
export const DARWIN_RESPONSE_ID_RE = /^sresp_[a-f0-9-]{36}$/;

export const positiveCentsSchema = z
  .number()
  .int("price must be integer cents")
  .positive("price must be positive")
  .max(MAX_PRICE_CENTS, "price is too large");

export const searchRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(2000),
    marketplaceId: marketplaceIdSchema.optional(),
    maxPriceCents: positiveCentsSchema.optional(),
    location: z.string().trim().min(1).max(200).optional(),
    includeExternalAgents: z.boolean().optional().default(true),
    previousResponseId: z
      .string()
      .regex(DARWIN_RESPONSE_ID_RE, "previousResponseId must be a Darwin responseId (sresp_…)")
      .optional(),
  })
  .strict()
  .refine((r) => !(r.previousResponseId && r.includeExternalAgents === false), {
    message: "previousResponseId requires includeExternalAgents to be true",
    path: ["previousResponseId"],
  });
export type SearchRequestInput = z.input<typeof searchRequestSchema>;

/**
 * HTTP callers are always the simulated web buyer: `buyerId` / `source` are rejected here and only
 * settable by in-process callers (Developer A's SMS router) via `createOffer`.
 */
export const createOfferRequestSchema = z
  .object({
    listingId: z.string().trim().min(1).max(40),
    priceCents: positiveCentsSchema,
  })
  .strict();

export const createListingRequestSchema = z
  .object({
    sellerId: z.string().trim().min(1).max(80),
    marketplaceId: marketplaceIdSchema,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    priceCents: positiveCentsSchema,
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter code")
      .toUpperCase()
      .optional(),
    location: z.string().trim().max(200).nullable().optional(),
    visibility: z.enum(["cross_market", "marketplace_only"]).optional(),
  })
  .strict();
