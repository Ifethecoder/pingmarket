/**
 * Zod schemas for the HTTP contract (frozen; see src/lib/types.ts for the TS shapes).
 * Route handlers validate request bodies with these; services receive typed values.
 */
import { z } from "zod";
import { MARKETPLACE_IDS } from "./types";

export const marketplaceIdSchema = z.enum(MARKETPLACE_IDS);

export const positiveCentsSchema = z
  .number()
  .int("price must be integer cents")
  .positive("price must be positive");

export const searchRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(2000),
    marketplaceId: marketplaceIdSchema.optional(),
    maxPriceCents: positiveCentsSchema.optional(),
    location: z.string().trim().min(1).max(200).optional(),
    includeExternalAgents: z.boolean().optional().default(true),
  })
  .strict();
export type SearchRequestInput = z.input<typeof searchRequestSchema>;

export const createOfferRequestSchema = z
  .object({
    listingId: z.string().trim().min(1).max(40),
    priceCents: positiveCentsSchema,
    buyerId: z.string().trim().min(1).max(80).optional(),
    source: z.enum(["sms", "web_simulated"]).optional(),
  })
  .strict();

export const createListingRequestSchema = z
  .object({
    sellerId: z.string().trim().min(1).max(80),
    marketplaceId: marketplaceIdSchema,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    priceCents: positiveCentsSchema,
    currency: z.string().length(3).toUpperCase().optional(),
    location: z.string().trim().max(200).nullable().optional(),
    visibility: z.enum(["cross_market", "marketplace_only"]).optional(),
  })
  .strict();
