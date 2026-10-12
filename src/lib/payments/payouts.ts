/**
 * Seller payouts: Stripe Connect "separate charges and transfers", TEST MODE ONLY.
 *
 * The buyer pays the platform through hosted Checkout in USD (`stripe.ts`). Once that payment is confirmed
 * the platform transfers the seller's share to the seller's Custom test connected account, funded from that
 * exact charge (`source_transaction`), so no available platform balance is needed. Connected accounts live
 * in the PLATFORM's country and transfers are made in the platform's settlement currency (e.g. JPY for a JP
 * platform), from the charge's balance transaction NET of Stripe's fees, minus `PLATFORM_FEE_BPS`.
 * Money stays in the connected account's test balance: no bank payout, no live settlement.
 *
 * One transfer per order: an atomic claim (`payout_status = 'in_progress'`) lets only one attempt talk to
 * Stripe at a time; every attempt first looks for an existing transfer in the order's `transfer_group`;
 * and the transfer request carries an idempotency key that only changes after a definitive refusal.
 *
 * Payout problems never undo or block the buyer's payment: they are recorded on the order
 * (`payout_status` / `payout_error`) and can be retried.
 */
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import Stripe from "stripe";
import { getDb, type Db } from "../db";
import { listings, offers, orders, users } from "../db/schema";
import { getOrder, OrderError } from "../orders/service";
import { notifyPayoutSent } from "../sms/deliver";
import type { Order } from "../types";
import { getPayoutStripe, isStripeConfigured } from "./stripe";

type TransferSummary = Pick<Stripe.Transfer, "id" | "amount" | "amount_reversed" | "reversed" | "currency" | "metadata">;

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
    list(params: Stripe.TransferListParams): Promise<{ data: TransferSummary[]; has_more: boolean }>;
    createReversal(id: string): Promise<Pick<Stripe.TransferReversal, "id">>;
  };
  accounts: {
    create(params: Stripe.AccountCreateParams, options?: Stripe.RequestOptions): Promise<Pick<Stripe.Account, "id">>;
    /** `null` = the platform account itself. */
    retrieve(id: string | null): Promise<Pick<Stripe.Account, "id" | "capabilities" | "country" | "default_currency">>;
    list(params: Stripe.AccountListParams): Promise<{ data: Array<Pick<Stripe.Account, "id" | "metadata">>; has_more: boolean }>;
    del(id: string): Promise<Pick<Stripe.DeletedAccount, "id" | "deleted">>;
  };
}

/** True when an injected client can also do payouts (full fake or real Stripe). */
export function isPayoutClient(client: unknown): client is StripePayoutClient {
  return typeof client === "object" && client !== null && "transfers" in client && "accounts" in client;
}

/** `PLATFORM_FEE_BPS` as integer basis points: digits only (else 0, with a warning), at most 10000. */
export function platformFeeBps(): number {
  const raw = process.env.PLATFORM_FEE_BPS?.trim();
  if (!raw) return 0;
  if (!/^\d+$/.test(raw)) {
    console.warn(`[payouts] PLATFORM_FEE_BPS=${raw.slice(0, 20)} is not a whole number of basis points; using 0`);
    return 0;
  }
  const bps = Number(raw);
  if (bps > 10_000) {
    console.warn(`[payouts] PLATFORM_FEE_BPS=${bps} is above 10000 (100%); using 10000`);
    return 10_000;
  }
  return bps;
}

/**
 * Seller share of a settled charge (minor units of the settlement currency). The platform fee is taken from
 * the NET amount (after Stripe's processing fee); `platformFeeCents` is everything the platform keeps:
 * `gross - payout` (Stripe's fee + the platform fee).
 */
export function splitSale(
  { gross, net }: { gross: number; net: number },
  bps = platformFeeBps(),
): { payoutCents: number; platformFeeCents: number } {
  const payoutCents = Math.max(0, net - Math.round((net * bps) / 10_000));
  return { payoutCents, platformFeeCents: gross - payoutCents };
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

/**
 * True when Stripe definitively refused the request (4xx: it did not and will not create anything for it).
 * Connection errors, 5xx and rate limits are ambiguous or transient: the request may have gone through, so a
 * retry must reuse the same idempotency key.
 */
function isDefinitiveRefusal(err: unknown): boolean {
  return (
    err instanceof Stripe.errors.StripeInvalidRequestError ||
    err instanceof Stripe.errors.StripePermissionError ||
    err instanceof Stripe.errors.StripeIdempotencyError ||
    err instanceof Stripe.errors.StripeCardError ||
    err instanceof Stripe.errors.StripeAuthenticationError
  );
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

/** The platform's country has no built-in test seller data; recorded as `not_configured`. */
export class PayoutSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutSetupError";
  }
}

/**
 * Custom TEST connected account params with Stripe's documented test values (docs.stripe.com/connect/testing)
 * and the fields Stripe lists as required for an individual with card_payments + transfers in that country.
 * Deterministic for a given `minuteBucket` so a replayed idempotency key always carries identical params.
 * The JP address is fictional (架空市 / 架空町); Stripe documents no JP address test token.
 */
export function testAccountParams(
  userId: string,
  platform: PlatformAccount,
  minuteBucket = Math.floor(Date.now() / 60_000),
): Stripe.AccountCreateParams {
  const common = {
    type: "custom",
    business_type: "individual",
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    business_profile: {
      mcc: "5734",
      product_description: "PingMarket test seller",
      url: "https://accessible.stripe.com",
    },
    tos_acceptance: { date: minuteBucket * 60, ip: "127.0.0.1" },
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
          postal_code: "1000000",
          state: "ﾄｳｷﾖｳﾄ",
          city: "ｶｸｳｼ",
          town: "ｶｸｳﾁｮｳ",
          line1: "1-1",
        },
        address_kanji: {
          postal_code: "1000000",
          state: "東京都",
          city: "架空市",
          town: "架空町",
          line1: "1-1",
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

/** An account Stripe already has for this user (`metadata.pingmarketUserId`), from the newest 100. */
async function findExistingAccount(client: StripePayoutClient, userId: string): Promise<string | null> {
  const page = await client.accounts.list({ limit: 100 });
  return page.data.find((a) => a.metadata?.pingmarketUserId === userId)?.id ?? null;
}

/**
 * Returns the seller's connected account id, creating a Custom TEST account in the platform's country on
 * first use (`testAccountParams`) so it can receive transfers without onboarding. Refuses non-test keys.
 * Reuses an account Stripe already has for the user (lost response / failed save); concurrent creators
 * converge on one stored id and the loser deletes its own new account.
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

  const client = stripe ?? getPayoutStripe();
  const platform = await getPlatformAccount(client);
  let accountId = await findExistingAccount(client, userId);
  let createdHere = false;
  if (!accountId) {
    const minute = Math.floor(Date.now() / 60_000);
    const account = await client.accounts.create(
      testAccountParams(userId, platform, minute),
      // Stripe replays a cached ERROR for a reused key for 24h (verified live), so the key is per minute:
      // concurrent callers still dedupe, and a retry after enabling Connect is a fresh request.
      { idempotencyKey: `pingmarket-seller-${userId}-${minute}` },
    );
    accountId = account.id;
    createdHere = true;
  }

  const [saved] = await conn
    .update(users)
    .set({ stripeAccountId: accountId })
    .where(and(eq(users.id, userId), isNull(users.stripeAccountId)))
    .returning({ id: users.stripeAccountId });
  if (saved?.id) return saved.id;
  const [winner] = await conn.select({ id: users.stripeAccountId }).from(users).where(eq(users.id, userId)).limit(1);
  if (!winner?.id) throw new Error(`Could not store a connected account for ${userId}`);
  if (createdHere && winner.id !== accountId) {
    console.warn(`[payouts] ${userId}: another request stored ${winner.id}; deleting duplicate ${accountId}`);
    await client.accounts.del(accountId).catch((err: unknown) => {
      console.error(`[payouts] could not delete duplicate account ${accountId}: ${shortError(err)}`);
    });
  }
  return winner.id;
}

export type PayoutOutcome = "paid" | "already_paid" | "in_progress" | "not_configured" | "failed";

export interface PayoutResult {
  order: Order;
  outcome: PayoutOutcome;
  transferId: string | null;
  error?: string;
}

/** How long an `in_progress` claim blocks other attempts before it is considered abandoned. */
const CLAIM_TTL = sql`interval '2 minutes'`;

async function reload(orderId: string, db: Db): Promise<Order> {
  const order = await getOrder(orderId, db);
  if (!order) throw new OrderError("ORDER_NOT_FOUND", `Order ${orderId} not found`);
  return order;
}

/**
 * Atomically takes the order's payout claim. Returns the attempt number to build the idempotency key from,
 * or null when the payout is already paid or another attempt holds a fresh claim.
 */
async function claimPayout(orderId: string, db: Db): Promise<number | null> {
  const [claimed] = await db
    .update(orders)
    .set({ payoutStatus: "in_progress", payoutClaimedAt: sql`now()` })
    .where(
      and(
        eq(orders.id, orderId),
        ne(orders.payoutStatus, "paid"),
        or(
          ne(orders.payoutStatus, "in_progress"),
          isNull(orders.payoutClaimedAt),
          sql`${orders.payoutClaimedAt} < now() - ${CLAIM_TTL}`,
        ),
      ),
    )
    .returning({ attempts: orders.payoutAttempts });
  return claimed ? claimed.attempts : null;
}

async function recordNotConfigured(orderId: string, reason: string, db: Db): Promise<PayoutResult> {
  console.warn(`[payouts] order ${orderId}: ${reason}; seller payout skipped`);
  await db
    .update(orders)
    .set({ payoutStatus: "not_configured", payoutError: reason, payoutAt: new Date(), payoutClaimedAt: null })
    .where(and(eq(orders.id, orderId), ne(orders.payoutStatus, "paid")));
  return { order: await reload(orderId, db), outcome: "not_configured", transferId: null, error: reason };
}

/**
 * Records a failed attempt and releases the claim. `definitive` (Stripe refused the transfer) moves to the
 * next idempotency key; otherwise the next attempt reuses the same key, which is safe to replay.
 */
async function recordFailure(
  orderId: string,
  error: string,
  db: Db,
  { definitive = false, paymentIntentId = null }: { definitive?: boolean; paymentIntentId?: string | null } = {},
): Promise<PayoutResult> {
  console.error(`[payouts] order ${orderId}: seller payout failed: ${error}`);
  await db
    .update(orders)
    .set({
      payoutStatus: "failed",
      payoutError: error,
      payoutAt: new Date(),
      payoutClaimedAt: null,
      ...(definitive ? { payoutAttempts: sql`${orders.payoutAttempts} + 1` } : {}),
      ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
    })
    .where(and(eq(orders.id, orderId), ne(orders.payoutStatus, "paid")));
  return { order: await reload(orderId, db), outcome: "failed", transferId: null, error };
}

/** A live (not fully reversed) transfer Stripe already has for this order, if any. */
async function findExistingTransfer(client: StripePayoutClient, orderId: string): Promise<TransferSummary | null> {
  const page = await client.transfers.list({ transfer_group: orderId, limit: 10 });
  return (
    page.data.find((t) => t.metadata?.orderId === orderId && !t.reversed && (t.amount_reversed ?? 0) < t.amount) ?? null
  );
}

/**
 * Transfers the seller's share of a PAID order to the seller's connected account, at most once.
 * - Already `payout_status = 'paid'`: returns without calling Stripe. Another attempt in flight: `in_progress`.
 * - Connect not set up / zero payout: `not_configured`. Stripe or charge problems (refunded, disputed, not
 *   succeeded, session not in this account, …) and unexpected errors: `failed` with a short error.
 *   None of these throw. Throws `OrderError` only for ORDER_NOT_FOUND / ORDER_NOT_PAID / STRIPE_NOT_CONFIGURED.
 * Duplicate protection: an atomic claim admits one attempt at a time; each attempt first adopts any existing
 * transfer in the order's `transfer_group` (covers lost responses and failed DB writes, even after the
 * idempotency key expired); the transfer request's idempotency key (`pingmarket-payout-{order}-{attempt}`)
 * only advances after a definitive refusal, so ambiguous failures (timeouts, 5xx) replay the same request.
 * If a different transfer was recorded meanwhile, ours is reversed.
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
  const client = stripe ?? getPayoutStripe();

  const attempt = await claimPayout(orderId, conn);
  if (attempt === null) {
    const current = await reload(orderId, conn);
    return current.payoutStatus === "paid"
      ? { order: current, outcome: "already_paid", transferId: current.stripeTransferId }
      : { order: current, outcome: "in_progress", transferId: null };
  }

  let paymentIntentId: string | null = null;
  try {
    let destination: string;
    try {
      destination = await ensureSellerConnectedAccount(sellerId, { stripe: client, db: conn });
    } catch (err) {
      const reason = err instanceof PayoutSetupError ? err.message : connectUnavailableReason(err);
      if (reason) return await recordNotConfigured(orderId, reason, conn);
      throw err;
    }

    if (!order.stripeCheckoutSessionId) return await recordFailure(orderId, "no Checkout session on the order", conn);
    let session: Pick<Stripe.Checkout.Session, "id" | "payment_intent">;
    try {
      session = await client.checkout.sessions.retrieve(order.stripeCheckoutSessionId, {
        expand: ["payment_intent.latest_charge.balance_transaction"],
      });
    } catch (err) {
      if (!isResourceMissing(err)) throw err;
      return await recordFailure(
        orderId,
        "Checkout session not found in this Stripe account (paid with a different STRIPE_SECRET_KEY?)",
        conn,
      );
    }
    const intent = session.payment_intent;
    paymentIntentId = typeof intent === "string" ? intent : (intent?.id ?? null);
    const charge = intent && typeof intent === "object" ? intent.latest_charge : null;
    if (!paymentIntentId || !charge || typeof charge !== "object") {
      return await recordFailure(orderId, "no charge found on the Checkout session", conn, { paymentIntentId });
    }
    if (charge.status !== "succeeded") {
      return await recordFailure(orderId, `charge ${charge.id} is ${charge.status}, not succeeded`, conn, { paymentIntentId });
    }
    if (charge.refunded || charge.amount_refunded > 0) {
      return await recordFailure(orderId, `charge ${charge.id} was refunded; no seller payout`, conn, { paymentIntentId });
    }
    if (charge.disputed) {
      return await recordFailure(orderId, `charge ${charge.id} is disputed; no seller payout`, conn, { paymentIntentId });
    }
    const balance = charge.balance_transaction;
    if (!balance || typeof balance !== "object") {
      return await recordFailure(orderId, "charge has no balance transaction yet", conn, { paymentIntentId });
    }

    // Settlement currency (e.g. USD charge -> JPY), net of Stripe's fee, minus the platform fee.
    const currency = balance.currency.toLowerCase();
    const bps = platformFeeBps();
    const { payoutCents, platformFeeCents } = splitSale({ gross: balance.amount, net: balance.net }, bps);

    let transfer: TransferSummary | Pick<Stripe.Transfer, "id"> | null = await findExistingTransfer(client, order.id);
    let createdHere = false;
    if (!transfer) {
      if (payoutCents <= 0) {
        return await recordNotConfigured(orderId, `Payout amount is 0 (PLATFORM_FEE_BPS=${bps})`, conn);
      }
      try {
        transfer = await client.transfers.create(
          {
            amount: payoutCents,
            currency,
            destination,
            transfer_group: order.id,
            source_transaction: charge.id,
            metadata: { orderId: order.id, offerId: order.offerId, sellerId },
          },
          { idempotencyKey: `pingmarket-payout-${order.id}-${attempt}` },
        );
        createdHere = true;
      } catch (err) {
        if (isDefinitiveRefusal(err)) {
          return await recordFailure(orderId, shortError(err), conn, { definitive: true, paymentIntentId });
        }
        return await recordFailure(orderId, `${shortError(err)} (retry safe: same request is replayed)`, conn, {
          paymentIntentId,
        });
      }
    }
    // An adopted transfer is recorded with its own amount (e.g. made before a fee change).
    const amount = "amount" in transfer ? transfer.amount : payoutCents;

    const [updated] = await conn
      .update(orders)
      .set({
        payoutStatus: "paid",
        stripeTransferId: transfer.id,
        stripePaymentIntentId: paymentIntentId,
        payoutAmountCents: amount,
        platformFeeCents: balance.amount - amount,
        payoutCurrency: currency,
        payoutError: null,
        payoutAt: new Date(),
        payoutClaimedAt: null,
      })
      .where(and(eq(orders.id, orderId), ne(orders.payoutStatus, "paid")))
      .returning({ id: orders.id });
    const current = await reload(orderId, conn);
    if (!updated) {
      if (createdHere && current.stripeTransferId && current.stripeTransferId !== transfer.id) {
        console.error(
          `[payouts] CONFLICT: order ${orderId} already recorded transfer ${current.stripeTransferId}; reversing duplicate ${transfer.id}`,
        );
        await client.transfers.createReversal(transfer.id).catch((err: unknown) => {
          console.error(`[payouts] could not reverse duplicate transfer ${transfer.id}: ${shortError(err)}`);
        });
      }
      return { order: current, outcome: "already_paid", transferId: current.stripeTransferId };
    }
    // A retry succeeded after the payment texts went out: tell the seller now. (A first attempt is
    // reported in the seller's "Sold!" text instead.)
    if (order.payoutStatus !== "not_started") await notifyPayoutSent(orderId, conn);
    return { order: current, outcome: "paid", transferId: transfer.id };
  } catch (err) {
    // Anything unexpected (Stripe outage, DB error, missing user, …): record it and release the claim.
    // Not definitive: no transfer request was refused, so the next attempt keeps the same key.
    return recordFailure(orderId, shortError(err), conn, { paymentIntentId });
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
    // Errors before the claim (e.g. reading the order): make them visible on the order too.
    try {
      const conn = db ?? (await getDb());
      await conn
        .update(orders)
        .set({ payoutStatus: "failed", payoutError: shortError(err), payoutAt: new Date(), payoutClaimedAt: null })
        .where(and(eq(orders.id, orderId), eq(orders.paymentStatus, "paid"), ne(orders.payoutStatus, "paid")));
    } catch (writeErr) {
      console.error(`[payouts] order ${orderId}: could not record payout error: ${shortError(writeErr)}`);
    }
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
 * `connectEnabled` is false when Stripe refused account creation because Connect is not set up.
 */
export async function provisionSellerAccounts(
  { stripe, db }: { stripe?: StripePayoutClient; db?: Db } = {},
): Promise<{ connectEnabled: boolean; sellers: SellerAccountStatus[] }> {
  requireTestKey();
  const conn = db ?? (await getDb());
  const client = stripe ?? getPayoutStripe();
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
