/**
 * Idempotent demo seed. Safe to run on every boot (onConflictDoNothing everywhere).
 * Listing ids D1..D8 are fixed; listing_id_seq is bumped to >= 100 so minted ids never collide.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "./index";
import { interests, listings, marketplaces, users } from "./schema";

type NewListing = typeof listings.$inferInsert;

const SEED_LISTINGS: NewListing[] = [
  {
    id: "D1",
    marketplaceId: "furniture",
    sellerId: "u_seller_demo",
    title: "Oak desk",
    description: "Solid oak writing desk with two drawers. Great home office desk, light wear on top.",
    priceCents: 12000,
    location: "Berkeley",
    visibility: "cross_market",
  },
  {
    id: "D2",
    marketplaceId: "furniture",
    sellerId: "u_seller_2",
    title: "Ergonomic office chair",
    description: "Mesh ergonomic office chair with lumbar support and adjustable arms.",
    priceCents: 9500,
    location: "Oakland",
    visibility: "cross_market",
  },
  {
    id: "D3",
    marketplaceId: "furniture",
    sellerId: "u_seller_demo",
    title: "Standing desk, adjustable",
    description: "Electric sit-stand desk, height adjustable with memory presets. Fits a dual-monitor setup.",
    priceCents: 22000,
    location: "Berkeley",
    visibility: "cross_market",
  },
  {
    id: "D4",
    marketplaceId: "furniture",
    sellerId: "u_seller_2",
    title: "Mid-century bookshelf",
    description: "Walnut-finish mid-century modern bookshelf, five shelves. Classic design piece.",
    priceCents: 8000,
    location: "San Francisco",
    visibility: "marketplace_only",
  },
  {
    id: "D5",
    marketplaceId: "furniture",
    sellerId: "u_seller_demo",
    title: "Floor lamp, brass",
    description: "Brass arc floor lamp, warm light for a reading corner or next to a desk.",
    priceCents: 4500,
    location: "Berkeley",
    visibility: "cross_market",
  },
  {
    id: "D6",
    marketplaceId: "creative",
    sellerId: "u_seller_2",
    title: "Abstract wall art print, 24x36",
    description: "Large abstract art print for a living room or office wall. Bold modern design, unframed.",
    priceCents: 6000,
    location: "Berkeley",
    visibility: "cross_market",
  },
  {
    id: "D7",
    marketplaceId: "creative",
    sellerId: "u_seller_demo",
    title: "Custom portrait commission (digital)",
    description: "Hand-drawn digital portrait art from your photo. Delivered as a high-res file, ready to print as a poster.",
    priceCents: 15000,
    location: null,
    visibility: "cross_market",
  },
  {
    id: "D8",
    marketplaceId: "creative",
    sellerId: "u_seller_2",
    title: "Vintage concert poster set",
    description: "Set of three vintage concert posters, original 1970s graphic design. Great wall art.",
    priceCents: 3500,
    location: "Oakland",
    visibility: "marketplace_only",
  },
];

/** Fixed fake phone of the dashboard demo seller (never a real handset). */
export const SELLER_DEMO_PHONE = "+15550000002";
/** The real Dial participant phone (Number B) is the SMS buyer `u_sms_buyer`. */
export const SMS_BUYER_ID = "u_sms_buyer";

export function smsBuyerPhone(): string {
  return process.env.DIAL_PARTICIPANT_NUMBER?.trim() || process.env.DIAL_NUMBER_B?.trim() || "+15550000011";
}

/**
 * Older databases mapped the real participant phone to the seller `u_seller_demo`. users.phone is
 * unique, so: free the fake seller phone from any other user, move the seller onto it, then point
 * `u_sms_buyer` at the current participant phone. Returns the phone `u_sms_buyer` may hold (null when
 * another user already has the participant phone). Idempotent; runs on every boot.
 */
async function reconcilePhones(db: Db, buyerPhone: string): Promise<string | null> {
  const sellerPhone = buyerPhone === SELLER_DEMO_PHONE ? null : SELLER_DEMO_PHONE;
  if (sellerPhone) {
    await db.update(users).set({ phone: null }).where(and(eq(users.phone, sellerPhone), ne(users.id, "u_seller_demo")));
  }
  await db
    .update(users)
    .set({ phone: sellerPhone })
    .where(and(eq(users.id, "u_seller_demo"), sql`${users.phone} is distinct from ${sellerPhone}::text`));
  const [holder] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.phone, buyerPhone), ne(users.id, SMS_BUYER_ID)))
    .limit(1);
  if (holder) {
    console.warn(`[seed] the participant phone is already used by ${holder.id}; ${SMS_BUYER_ID} keeps no phone`);
    return null;
  }
  await db
    .update(users)
    .set({ phone: buyerPhone })
    .where(and(eq(users.id, SMS_BUYER_ID), sql`${users.phone} is distinct from ${buyerPhone}::text`));
  return buyerPhone;
}

export async function seed(db: Db): Promise<void> {
  const buyerPhone = smsBuyerPhone();
  await db
    .insert(marketplaces)
    .values([
      { id: "furniture", name: "Furniture Market", category: "furniture", dialNumber: null },
      { id: "creative", name: "Creative Market", category: "creative", dialNumber: null },
    ])
    .onConflictDoNothing();

  const smsBuyerPhoneToUse = await reconcilePhones(db, buyerPhone);
  await db
    .insert(users)
    .values([
      {
        id: "u_seller_demo",
        phone: buyerPhone === SELLER_DEMO_PHONE ? null : SELLER_DEMO_PHONE,
        role: "seller",
        consentStatus: "opted_in",
      },
      { id: "u_seller_2", phone: "+15550000003", role: "seller", consentStatus: "opted_in" },
      // The dashboard's simulated buyer (offers with source `web_simulated`).
      { id: "u_web_buyer", phone: null, role: "buyer", consentStatus: "opted_in" },
      { id: "u_operator", phone: null, role: "operator", consentStatus: "unknown" },
    ])
    .onConflictDoNothing();
  // The real buyer phone texting the Dial service number (offers with source `sms`). Inserted on its own
  // so a phone conflict can never silently skip creating the user.
  await db
    .insert(users)
    .values({ id: SMS_BUYER_ID, phone: smsBuyerPhoneToUse, role: "buyer", consentStatus: "opted_in" })
    .onConflictDoNothing({ target: users.id });

  await db
    .insert(listings)
    .values(SEED_LISTINGS.map((l) => ({ ...l, status: "available" as const })))
    .onConflictDoNothing();

  await db
    .insert(interests)
    .values({
      id: "int_seed_office_chair",
      buyerId: "u_web_buyer",
      query: "office chair",
      maxPriceCents: 10000,
      location: "Berkeley",
      enabled: true,
    })
    .onConflictDoNothing();

  // Keep minted D{n} ids clear of the fixed seed ids. No-op once the sequence is past 100.
  await db.execute(
    sql`select setval('listing_id_seq', 100, true) where (select last_value from listing_id_seq) < 100`,
  );
}
