/**
 * Seller payouts: Stripe Connect "separate charges and transfers", TEST MODE ONLY.
 *
 * The buyer pays the platform through hosted Checkout in USD (`stripe.ts`). Once that payment is confirmed
 * the platform transfers the sale (minus `PLATFORM_FEE_BPS`) to the seller's Custom test connected account,
 * funded from that exact charge (`source_transaction`), so no available platform balance is needed.
 * Connected accounts live in the PLATFORM's country and transfers are made in the platform's settlement
 * currency (e.g. JPY for a JP platform), computed from the charge's balance transaction.
 * Money stays in the connected account's test balance: no bank payout, no live settlement.
 *
 * Payout problems never undo or block the buyer's payment: they are recorded on the order
 * (`payout_status` / `payout_error`) and can be retried.
 */
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import Stripe from "stripe";
import { getDb, type Db } from "../db";
import { listings, offers, orders, users } from "../db/schema";
import { getOrder, OrderError } from "../orders/service";
import { notifyPayoutSent } from "../sms/deliver";
import type { Order } from "../types";
import { getStripe, isStripeConfigured } from "./stripe";

/** The slice of the Stripe client used for payouts; tests inject a fake. */
export interface StripePayoutClient {
  checkout: {
    sessions: {
      retrieve(
        id: string,
        params?: Stripe.Checkout.SessionRetrieveParams,
      ): Promise<Pick<Stripe.Checkout.Session, "id" | "payment_intent">>;
    };
  };
  transfers: {
    create(params: Stripe.TransferCreateParams, options?: Stripe.RequestOptions): Promise<Pick<Stripe.Transfer, "id">>;
  };
  accounts: {
    create(params: Stripe.AccountCreateParams, options?: Stripe.RequestOptions): Promise<Pick<Stripe.Account, "id">>;
    /** `null` = the platform account itself. */
    retrieve(id: string | null): Promise<Pick<Stripe.Account, "id" | "capabilities" | "country" | "default_currency">>;
  };
}

/** True when an injected client can also do payouts (full fake or real Stripe). */
export function isPayoutClient(client: unknown): client is StripePayoutClient {
  return typeof client === "object" && client !== null && "transfers" in client && "accounts" in client;
}

/** `PLATFORM_FEE_BPS` as integer basis points, default 0, clamped to 0..10000. */
export function platformFeeBps(): number {
  const bps = Number.parseInt(process.env.PLATFORM_FEE_BPS ?? "", 10);
  return Number.isFinite(bps) ? Math.min(10_000, Math.max(0, bps)) : 0;
}

/** Splits a gross amount (minor units of any currency) into `{ feeCents, payoutCents }` using `platformFeeBps()`. */
export function splitSale(amountMinor: number, bps = platformFeeBps()): { feeCents: number; payoutCents: number } {
  const feeCents = Math.round((amountMinor * bps) / 10_000);
  return { feeCents, payoutCents: amountMinor - feeCents };
}

export const PLATFORM_PROFILE_HINT = "Review Connect platform profile: dashboard.stripe.com/settings/connect/platform-profile";

/**
 * Maps Stripe's "Connect is not set up for this" refusals (no `code`, so matched on the message) to a short
 * operator hint, or null for any other error:
 * - Connect not enabled ("…signed up for Connect");
 * - platform profile not reviewed ("…responsibilities of collecting requirements…/platform-profile");
 * - Accounts v1 creation disabled by API policy ("…Accounts v1…/v2/core/accounts").
 */
export function connectUnavailableReason(err: unknown): string | null {
  if (!(err instanceof Stripe.errors.StripeError)) return null;
  const message = err.message ?? "";
  if (/signed up for Connect/i.test(message)) return "Stripe Connect not enabled";
  if (/platform[-_ ]profile|responsibilities of collecting requirements/i.test(message)) return PLATFORM_PROFILE_HINT;
  if (/Accounts v1|\/v2\/core\/accounts/i.test(message)) {
    return "Stripe Accounts v1 support off (Dashboard → Settings → Developers → API policies)";
  }
  return null;
}

function isResourceMissing(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeInvalidRequestError && err.code === "resource_missing";
}

export interface PlatformAccount {
  country: string;
  /** Lowercase settlement currency, e.g. `jpy`. */
  currency: string;
}

const platformCache = new WeakMap<object, Promise<PlatformAccount>>();

/** The platform account's country and default (settlement) currency, read once per client. */
export function getPlatformAccount(client: StripePayoutClient): Promise<PlatformAccount> {
  let cached = platformCache.get(client);
  if (!cached) {
    cached = client.accounts.retrieve(null).then((acct) => {
      if (!acct.country || !acct.default_currency) throw new Error("Stripe platform account has no country/currency");
      return { country: acct.country.toUpperCase(), currency: acct.default_currency.toLowerCase() };
    });
    cached.catch(() => platformCache.delete(client));
    platformCache.set(client, cached);
  }
  return cached;
}

/** `type:code message`, capped; never the raw Stripe error object. */
function shortError(err: unknown): string {
  if (err instanceof Stripe.errors.StripeError) {
    return `${err.rawType ?? err.type}:${err.code ?? "-"} ${err.message}`.slice(0, 200);
  }
  return (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 200);
}

function requireTestKey(): void {
  if (!isStripeConfigured()) {
    throw new OrderError("STRIPE_NOT_CONFIGURED", "Stripe not configured (set STRIPE_SECRET_KEY to a test-mode key)");
  }
}

/** Countries with built-in test onboarding data. Cross-border transfers aren't available to every platform, */
/** so sellers are always created in the platform's own country. */
export const SUPPORTED_SELLER_COUNTRIES = ["US", "JP"] as const;

/**
 * Custom TEST connected account params with Stripe's documented test values (docs.stripe.com/connect/testing)
 * and the fields Stripe lists as required for an individual with card_payments + transfers in that country.
 */
export function testAccountParams(userId: string, platform: PlatformAccount): Stripe.AccountCreateParams {
  const common = {
    type: "custom",
    business_type: "individual",
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    business_profile: {
      mcc: "5734",
      product_description: "PingMarket test seller",
      url: "https://accessible.stripe.com",
    },
    tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: "127.0.0.1" },
    metadata: { pingmarketUserId: userId },
  } satisfies Partial<Stripe.AccountCreateParams>;

  if (platform.country === "US") {
    return {
      ...common,
      country: "US",
      individual: {
        first_name: "Test",
        last_name: `Seller ${userId}`,
        dob: { day: 1, month: 1, year: 1902 },
        id_number: "222222222",
        email: `${userId}@example.com`,
        phone: "0000000000",
        address: {
          line1: "address_full_match",
          city: "San Francisco",
          state: "CA",
          postal_code: "94103",
          country: "US",
        },
      },
      external_account: "btok_us_verified",
    };
  }
  if (platform.country === "JP") {
    return {
      ...common,
      country: "JP",
      individual: {
        first_name_kana: "ﾃｽﾄ",
        last_name_kana: "ｾﾗｰ",
        first_name_kanji: "テスト",
        last_name_kanji: "セラー",
        dob: { day: 1, month: 1, year: 1902 },
        email: `${userId}@example.com`,
        phone: "0000000000",
        address_kana: {
          postal_code: "1500001",
          state: "ﾄｳｷﾖｳﾄ",
          city: "ｼﾌﾞﾔｸ",
          town: "ｼﾞﾝｸﾞｳﾏｴ 3-",
          line1: "27-15",
        },
        address_kanji: {
          postal_code: "1500001",
          state: "東京都",
          city: "渋谷区",
          town: "神宮前 3丁目",
          line1: "27-15",
        },
        verification: { document: { front: "file_identity_document_success" } },
      },
      external_account: {
        object: "bank_account",
        country: "JP",
        currency: "jpy",
        routing_number: "1100000",
        account_number: "0001234",
        account_holder_name: "ﾃｽﾄ ｾﾗｰ",
      },
    };
  }
  throw new PayoutSetupError(
    `No test seller data for platform country ${platform.country} (supported: ${SUPPORTED_SELLER_COUNTRIES.join(", ")})`,
  );
}

/** The platform's country has no built-in test seller data; recorded as `not_configured`. */
export class PayoutSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutSetupError";
  }
}

/**
 * Returns the seller's connected account id, creating a Custom TEST account in the platform's country on
 * first use (`testAccountParams`) so it can receive transfers without onboarding. Refuses non-test keys.
 * Concurrent callers converge on one stored id.
 */
export async function ensureSellerConnectedAccount(
  userId: string,
  { stripe, db }: { stripe?: StripePayoutClient; db?: Db } = {},
): Promise<string> {
  requireTestKey();
  const conn = db ?? (await getDb());
  const [user] = await conn
    .select({ id: users.id, stripeAccountId: users.stripeAccountId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw new Error(`User ${userId} not found`);
  if (user.stripeAccountId) return user.stripeAccountId;

  const client = stripe ?? getStripe();
  const platform = await getPlatformAccount(client);
  const account = await client.accounts.create(
    testAccountParams(userId, platform),
    // Stripe replays a cached ERROR for a reused key for 24h (verified live), so the key is per minute:
    // concurrent callers still dedupe, and a retry after enabling Connect is a fresh request.
    { idempotencyKey: `pingmarket-seller-${userId}-${Math.floor(Date.now() / 60_000)}` },
  );

  const [saved] = await conn
    .update(users)
    .set({ stripeAccountId: account.id })
    .where(and(eq(users.id, userId), isNull(users.stripeAccountId)))
    .returning({ id: users.stripeAccountId });
  if (saved?.id) return saved.id;
  const [winner] = await conn.select({ id: users.stripeAccountId }).from(users).where(eq(users.id, userId)).limit(1);
  if (!winner?.id) throw new Error(`Could not store a connected account for ${userId}`);
  return winner.id;
}

export type PayoutOutcome = "paid" | "already_paid" | "not_configured" | "failed";

export interface PayoutResult {
  order: Order;
  outcome: PayoutOutcome;
  transferId: string | null;
  error?: string;
}

async function reload(orderId: string, db: Db): Promise<Order> {
  const order = await getOrder(orderId, db);
  if (!order) throw new OrderError("ORDER_NOT_FOUND", `Order ${orderId} not found`);
  return order;
}

async function recordNotConfigured(orderId: string, reason: string, db: Db): Promise<PayoutResult> {
  console.warn(`[payouts] order ${orderId}: ${reason}; seller payout skipped`);
  await db
    .update(orders)
    .set({ payoutStatus: "not_configured", payoutError: reason, payoutAt: new Date() })
    .where(and(eq(orders.id, orderId), ne(orders.payoutStatus, "paid")));
  return { order: await reload(orderId, db), outcome: "not_configured", transferId: null, error: reason };
}

async function recordFailure(
  orderId: string,
  error: string,
  db: Db,
  paymentIntentId: string | null = null,
): Promise<PayoutResult> {
  console.error(`[payouts] order ${orderId}: seller payout failed: ${error}`);
  await db
    .update(orders)
    .set({
      payoutStatus: "failed",
      payoutError: error,
      payoutAttempts: sql`${orders.payoutAttempts} + 1`,
      payoutAt: new Date(),
      ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
    })
    .where(and(eq(orders.id, orderId), ne(orders.payoutStatus, "paid")));
  return { order: await reload(orderId, db), outcome: "failed", transferId: null, error };
}

/**
 * Transfers the seller's share of a PAID order to the seller's connected account (once).
 * - Already `payout_status = 'paid'`: returns without calling Stripe.
 * - Connect not enabled: records `not_configured`; Stripe/charge problems: records `failed` with a short
 *   error. Neither throws. Throws `OrderError` for ORDER_NOT_FOUND / ORDER_NOT_PAID / STRIPE_NOT_CONFIGURED.
 * The transfer is funded by the order's own charge (`source_transaction`), grouped by `transfer_group`
 * = order id, and made in the charge's settlement currency for its gross settled amount minus the fee. Its idempotency key includes the failed-attempt count, so concurrent calls make one transfer
 * while a retry after a recorded failure is a new request (Stripe caches errors per key for 24h).
 */
export async function payoutSeller(
  orderId: string,
  { stripe, db }: { stripe?: StripePayoutClient; db?: Db } = {},
): Promise<PayoutResult> {
  const conn = db ?? (await getDb());
  const [row] = await conn
    .select({ order: orders, sellerId: offers.sellerId })
    .from(orders)
    .innerJoin(offers, eq(orders.offerId, offers.id))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row) throw new OrderError("ORDER_NOT_FOUND", `Order ${orderId} not found`);
  const { order, sellerId } = row;
  if (order.paymentStatus !== "paid") {
    throw new OrderError("ORDER_NOT_PAID", `Order ${orderId} is ${order.paymentStatus}; the buyer has not paid`);
  }
  if (order.payoutStatus === "paid") {
    return { order: await reload(orderId, conn), outcome: "already_paid", transferId: order.stripeTransferId };
  }
  requireTestKey();
  const client = stripe ?? getStripe();

  let destination: string;
  try {
    destination = await ensureSellerConnectedAccount(sellerId, { stripe: client, db: conn });
  } catch (err) {
    const reason = err instanceof PayoutSetupError ? err.message : connectUnavailableReason(err);
    if (reason) return recordNotConfigured(orderId, reason, conn);
    if (err instanceof Stripe.errors.StripeError) return recordFailure(orderId, shortError(err), conn);
    throw err;
  }

  if (!order.stripeCheckoutSessionId) return recordFailure(orderId, "no Checkout session on the order", conn);
  let paymentIntentId: string | null = null;
  try {
    let session: Pick<Stripe.Checkout.Session, "id" | "payment_intent">;
    try {
      session = await client.checkout.sessions.retrieve(order.stripeCheckoutSessionId, {
        expand: ["payment_intent.latest_charge.balance_transaction"],
      });
    } catch (err) {
      if (!isResourceMissing(err)) throw err;
      return recordFailure(
        orderId,
        "Checkout session not found in this Stripe account (paid with a different STRIPE_SECRET_KEY?)",
        conn,
      );
    }
    const intent = session.payment_intent;
    paymentIntentId = typeof intent === "string" ? intent : (intent?.id ?? null);
    const charge = intent && typeof intent === "object" ? intent.latest_charge : null;
    const chargeId = typeof charge === "string" ? charge : (charge?.id ?? null);
    const balance = charge && typeof charge === "object" ? charge.balance_transaction : null;
    if (!paymentIntentId || !chargeId) {
      return recordFailure(orderId, "no charge found on the Checkout session", conn, paymentIntentId);
    }
    if (!balance || typeof balance !== "object") {
      return recordFailure(orderId, "charge has no balance transaction yet", conn, paymentIntentId);
    }

    // Transfer in the settlement currency: the charge's gross amount after conversion (e.g. USD -> JPY).
    const currency = balance.currency.toLowerCase();
    const { feeCents, payoutCents } = splitSale(balance.amount);
    let transferId: string | null = null;
    if (payoutCents > 0) {
      const transfer = await client.transfers.create(
        {
          amount: payoutCents,
          currency,
          destination,
          transfer_group: order.id,
          source_transaction: chargeId,
          metadata: { orderId: order.id, offerId: order.offerId, sellerId },
        },
        { idempotencyKey: `pingmarket-payout-${order.id}-${order.payoutAttempts}` },
      );
      transferId = transfer.id;
    }

    const [updated] = await conn
      .update(orders)
      .set({
        payoutStatus: "paid",
        stripeTransferId: transferId,
        stripePaymentIntentId: paymentIntentId,
        payoutAmountCents: payoutCents,
        platformFeeCents: feeCents,
        payoutCurrency: currency,
        payoutError: null,
        payoutAt: new Date(),
      })
      .where(and(eq(orders.id, orderId), ne(orders.payoutStatus, "paid")))
      .returning({ id: orders.id });
    const current = await reload(orderId, conn);
    // Another caller recorded the (same, idempotent) transfer first.
    if (!updated) return { order: current, outcome: "already_paid", transferId: current.stripeTransferId };
    // A retry succeeded after the payment texts went out: tell the seller now. (A first attempt is
    // reported in the seller's "Sold!" text instead.)
    if (order.payoutStatus !== "not_started") await notifyPayoutSent(orderId, conn);
    return { order: current, outcome: "paid", transferId };
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      return recordFailure(orderId, shortError(err), conn, paymentIntentId);
    }
    throw err;
  }
}

/**
 * Runs `payoutSeller` after a payment was confirmed. Never throws: the buyer's payment is already
 * recorded and must not be affected by a payout problem (which stays visible on the order).
 */
export async function payoutAfterPaid(
  orderId: string,
  { stripe, db }: { stripe?: StripePayoutClient; db?: Db } = {},
): Promise<void> {
  try {
    await payoutSeller(orderId, { stripe, db });
  } catch (err) {
    if (err instanceof OrderError && err.code === "STRIPE_NOT_CONFIGURED") {
      console.warn(`[payouts] order ${orderId}: seller payout skipped (no test-mode STRIPE_SECRET_KEY)`);
      return;
    }
    console.error(`[payouts] order ${orderId}: seller payout error: ${shortError(err)}`);
  }
}

/** Retries the payout of every paid order whose seller payout is not `paid` yet. */
export async function payoutPendingOrders(
  { stripe, db }: { stripe?: StripePayoutClient; db?: Db } = {},
): Promise<PayoutResult[]> {
  const conn = db ?? (await getDb());
  const rows = await conn
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.paymentStatus, "paid"), ne(orders.payoutStatus, "paid")))
    .orderBy(orders.createdAt);
  const results: PayoutResult[] = [];
  for (const { id } of rows) results.push(await payoutSeller(id, { stripe, db: conn }));
  return results;
}

export interface SellerAccountStatus {
  userId: string;
  accountId: string | null;
  /** `capabilities.transfers` on the connected account (`active` / `pending` / `inactive`), when known. */
  transfers: string | null;
  error?: string;
}

/**
 * Gets or creates a test connected account for every user who sells a listing. Test mode only.
 * `connectEnabled` is false when Stripe refused account creation because Connect is not enabled.
 */
export async function provisionSellerAccounts(
  { stripe, db }: { stripe?: StripePayoutClient; db?: Db } = {},
): Promise<{ connectEnabled: boolean; sellers: SellerAccountStatus[] }> {
  requireTestKey();
  const conn = db ?? (await getDb());
  const client = stripe ?? getStripe();
  const sellerRows = await conn.selectDistinct({ id: listings.sellerId }).from(listings).orderBy(listings.sellerId);
  let connectEnabled = true;
  const sellers: SellerAccountStatus[] = [];
  for (const { id: userId } of sellerRows) {
    try {
      const accountId = await ensureSellerConnectedAccount(userId, { stripe: client, db: conn });
      const account = await client.accounts.retrieve(accountId);
      sellers.push({ userId, accountId, transfers: account.capabilities?.transfers ?? null });
    } catch (err) {
      const reason = err instanceof PayoutSetupError ? err.message : connectUnavailableReason(err);
      if (reason) connectEnabled = false;
      sellers.push({ userId, accountId: null, transfers: null, error: reason ?? shortError(err) });
    }
  }
  return { connectEnabled, sellers };
}
