import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db";
import { offers, orders, users } from "../db/schema";
import { createTestDb } from "../db/testing";
import { createListing } from "../listings/service";
import { createOffer } from "../offers/service";
import { attachCheckoutSession, getOrCreateOrderForOffer, getOrder, markOrderPaid, OrderError } from "../orders/service";
import {
  connectUnavailableReason,
  ensureSellerConnectedAccount,
  payoutSeller,
  platformFeeBps,
  PLATFORM_PROFILE_HINT,
  splitSale,
  testAccountParams,
  type StripePayoutClient,
} from "./payouts";
import {
  applyPaidCheckoutSession,
  confirmOrderPayment,
  type CheckoutSessionSnapshot,
  type StripeCheckoutClient,
} from "./stripe";

let db: Db;
let sellerSeq = 0;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_payouts_unit");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const connectOff = () =>
  new Stripe.errors.StripeInvalidRequestError({
    type: "invalid_request_error",
    message: "You can only create new accounts if you've signed up for Connect, which you can do at https://dashboard.stripe.com/connect.",
  });

interface FakeTransfer {
  id: string;
  amount: number;
  amount_reversed: number;
  reversed: boolean;
  currency: string;
  destination: string;
  transfer_group: string | null;
  metadata: Record<string, string>;
}

type ChargeState = { status?: string; refunded?: boolean; amount_refunded?: number; disputed?: boolean };

/**
 * Stateful fake Stripe covering Checkout (confirm) and payouts, with Stripe's idempotency semantics:
 * a key replays its first result (or definitive error), and the same key with different params is an
 * idempotency error. Every session is paid; its charge settles `settle` (gross/net in the settlement currency).
 * `transferHooks.beforeCommit` runs before a transfer is recorded; `afterCommit` after (e.g. to lose the response).
 */
function fakeStripe({
  country = "US",
  currency = "usd",
  settle = { amount: 11000, net: 10650, currency: "usd" },
  charge = {},
}: {
  country?: string;
  currency?: string;
  settle?: { amount: number; net: number; currency: string };
  charge?: ChargeState;
} = {}) {
  const transfers: FakeTransfer[] = [];
  const accounts: { id: string; metadata: Record<string, string> }[] = [];
  const sessions = new Map<string, { orderId: string; amount: number }>();
  const idem = new Map<string, { params: string; result?: unknown; error?: unknown }>();
  const transferHooks: { beforeCommit?: () => Promise<void> | void; afterCommit?: () => Promise<void> | void } = {};

  async function idempotent<T>(key: string | undefined, params: unknown, run: () => Promise<T>): Promise<T> {
    if (!key) return run();
    const json = JSON.stringify(params);
    const prior = idem.get(key);
    if (prior) {
      if (prior.params !== json) {
        throw new Stripe.errors.StripeIdempotencyError({
          type: "idempotency_error",
          message: "Keys for idempotent requests can only be used with the same parameters they were first used with.",
        });
      }
      if (prior.error) throw prior.error;
      return prior.result as T;
    }
    try {
      const result = await run();
      idem.set(key, { params: json, result });
      return result;
    } catch (err) {
      // Stripe stores executed (4xx) outcomes; connection errors never reach it.
      if (err instanceof Stripe.errors.StripeInvalidRequestError) idem.set(key, { params: json, error: err });
      throw err;
    }
  }

  const accountsCreate = vi.fn((params: Stripe.AccountCreateParams, options?: Stripe.RequestOptions) =>
    idempotent(options?.idempotencyKey, params, async () => {
      const userId = (params.metadata as Record<string, string>).pingmarketUserId;
      const account = { id: `acct_${userId}_${accounts.length + 1}`, metadata: { pingmarketUserId: userId } };
      accounts.push(account);
      return { id: account.id };
    }),
  );
  const accountsRetrieve = vi.fn(async (id: string | null) =>
    id === null
      ? { id: "acct_platform", country, default_currency: currency, capabilities: undefined }
      : { id, country, default_currency: currency, capabilities: { transfers: "active" as const } },
  );
  const accountsList = vi.fn(async (params: Stripe.AccountListParams) => {
    void params;
    return { data: [...accounts].reverse(), has_more: false };
  });
  const accountsDel = vi.fn(async (id: string) => {
    const i = accounts.findIndex((a) => a.id === id);
    if (i >= 0) accounts.splice(i, 1);
    return { id, deleted: true as const };
  });

  const transfersCreate = vi.fn((params: Stripe.TransferCreateParams, options?: Stripe.RequestOptions) =>
    idempotent(options?.idempotencyKey, params, async () => {
      await transferHooks.beforeCommit?.();
      const transfer: FakeTransfer = {
        id: `tr_test_${transfers.length + 1}`,
        amount: params.amount!,
        amount_reversed: 0,
        reversed: false,
        currency: params.currency,
        destination: params.destination,
        transfer_group: params.transfer_group ?? null,
        metadata: params.metadata as Record<string, string>,
      };
      transfers.push(transfer);
      await transferHooks.afterCommit?.();
      return { id: transfer.id };
    }),
  );
  const transfersList = vi.fn(async (params: Stripe.TransferListParams) => ({
    data: transfers.filter((t) => t.transfer_group === params.transfer_group),
    has_more: false,
  }));
  const transfersReverse = vi.fn(async (id: string) => {
    const t = transfers.find((x) => x.id === id);
    if (t) Object.assign(t, { reversed: true, amount_reversed: t.amount });
    return { id: `trr_${id}` };
  });

  const sessionsRetrieve = vi.fn(async (id: string, params?: Stripe.Checkout.SessionRetrieveParams) => {
    void params;
    const known = sessions.get(id);
    if (!known) {
      throw new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: `No such checkout.session: '${id}'`,
        code: "resource_missing",
      });
    }
    const snapshot: CheckoutSessionSnapshot = {
      id,
      url: null,
      status: "complete",
      livemode: false,
      client_reference_id: known.orderId,
      metadata: { orderId: known.orderId },
      payment_status: "paid",
      amount_total: known.amount,
      currency: "usd",
    };
    const payment_intent = {
      id: `pi_${id}`,
      latest_charge: {
        id: `ch_${id}`,
        status: "succeeded",
        refunded: false,
        amount_refunded: 0,
        disputed: false,
        ...charge,
        balance_transaction: { id: `txn_${id}`, ...settle },
      },
    } as unknown as Stripe.PaymentIntent;
    return { ...snapshot, payment_intent };
  });

  const client: StripePayoutClient & StripeCheckoutClient = {
    accounts: { create: accountsCreate, retrieve: accountsRetrieve, list: accountsList, del: accountsDel },
    transfers: { create: transfersCreate, list: transfersList, createReversal: transfersReverse },
    checkout: { sessions: { retrieve: sessionsRetrieve, create: vi.fn(), expire: vi.fn() } },
  };
  return {
    client,
    accounts,
    transfers,
    sessions,
    transferHooks,
    accountsCreate,
    accountsList,
    accountsDel,
    transfersCreate,
    transfersList,
    transfersReverse,
    sessionsRetrieve,
  };
}

/** A fresh seller + listing + accepted offer + order with a stored session, optionally marked paid. */
async function orderForNewSeller(amount: number, { paid = true }: { paid?: boolean } = {}) {
  const sellerId = `u_payout_seller_${++sellerSeq}`;
  await db.insert(users).values({ id: sellerId, role: "seller" });
  const listing = await createListing({ sellerId, marketplaceId: "furniture", title: "Payout desk", priceCents: amount }, db);
  const offer = await createOffer({ listingId: listing.id, priceCents: amount }, db);
  await db.update(offers).set({ status: "accepted" }).where(eq(offers.id, offer.id));
  const { order } = await getOrCreateOrderForOffer(offer.id, db);
  const sessionId = `cs_test_payout${sellerSeq}`;
  await attachCheckoutSession(order.id, sessionId, null, db);
  if (paid) await markOrderPaid({ orderId: order.id, sessionId }, db);
  return { order, sellerId, sessionId };
}

async function setup(amount: number, options: Parameters<typeof fakeStripe>[0] = {}, paid = true) {
  const created = await orderForNewSeller(amount, { paid });
  const fake = fakeStripe(options);
  fake.sessions.set(created.sessionId, { orderId: created.order.id, amount });
  return { ...created, fake };
}

describe("fees", () => {
  it("takes the platform fee from the NET (after Stripe's fee); platform keeps gross - payout", () => {
    expect(splitSale({ gross: 11000, net: 10650 }, 0)).toEqual({ payoutCents: 10650, platformFeeCents: 350 });
    expect(splitSale({ gross: 11000, net: 10650 }, 250)).toEqual({ payoutCents: 10384, platformFeeCents: 616 });
    expect(splitSale({ gross: 16_489, net: 15_881 }, 1000)).toEqual({ payoutCents: 14_293, platformFeeCents: 2196 });
    expect(splitSale({ gross: 500, net: 450 }, 10_000)).toEqual({ payoutCents: 0, platformFeeCents: 500 });
  });

  it("parses PLATFORM_FEE_BPS as digits only (default 0, max 10000)", () => {
    expect(platformFeeBps()).toBe(0);
    for (const [raw, bps] of [
      ["250", 250],
      ["-5", 0],
      ["2.5", 0],
      ["abc", 0],
      ["20000", 10_000],
    ] as const) {
      vi.stubEnv("PLATFORM_FEE_BPS", raw);
      expect(platformFeeBps()).toBe(bps);
    }
  });
});

describe("payoutSeller", () => {
  it("transfers the net settled amount once: destination, source_transaction, transfer_group, idempotency key", async () => {
    const { order, sellerId, sessionId, fake } = await setup(11000);

    const result = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(result.outcome).toBe("paid");
    expect(fake.transfersCreate).toHaveBeenCalledTimes(1);
    const [params, options] = fake.transfersCreate.mock.calls[0];
    expect(params).toEqual({
      amount: 10650,
      currency: "usd",
      destination: fake.accounts[0].id,
      transfer_group: order.id,
      source_transaction: `ch_${sessionId}`,
      metadata: { orderId: order.id, offerId: order.offerId, sellerId },
    });
    expect(options).toEqual({ idempotencyKey: `pingmarket-payout-${order.id}-0` });
    expect(fake.transfersList).toHaveBeenCalledWith({ transfer_group: order.id, limit: 10 });
    expect(fake.sessionsRetrieve).toHaveBeenCalledWith(sessionId, {
      expand: ["payment_intent.latest_charge.balance_transaction"],
    });
    expect(result.order).toMatchObject({
      paymentStatus: "paid",
      payoutStatus: "paid",
      stripeTransferId: "tr_test_1",
      stripePaymentIntentId: `pi_${sessionId}`,
      payoutAmountCents: 10650,
      platformFeeCents: 350,
      payoutCurrency: "usd",
      payoutError: null,
    });

    // Already paid out: no Stripe call at all.
    fake.sessionsRetrieve.mockClear();
    const again = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(again).toMatchObject({ outcome: "already_paid", transferId: "tr_test_1" });
    expect(fake.transfersCreate).toHaveBeenCalledTimes(1);
    expect(fake.sessionsRetrieve).not.toHaveBeenCalled();
    expect(fake.accountsCreate).toHaveBeenCalledTimes(1);
  });

  it("pays a JP platform's seller in JPY from the net balance transaction, minus the fee", async () => {
    vi.stubEnv("PLATFORM_FEE_BPS", "1000");
    const { order, fake } = await setup(11000, {
      country: "JP",
      currency: "jpy",
      settle: { amount: 16_489, net: 15_881, currency: "jpy" },
    });

    const result = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(fake.transfersCreate.mock.calls[0][0]).toMatchObject({ amount: 14_293, currency: "jpy" });
    expect(result.order).toMatchObject({ payoutAmountCents: 14_293, platformFeeCents: 2196, payoutCurrency: "jpy" });

    const accountParams = fake.accountsCreate.mock.calls[0][0];
    expect(accountParams).toMatchObject({
      type: "custom",
      country: "JP",
      business_type: "individual",
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      external_account: { object: "bank_account", country: "JP", currency: "jpy", routing_number: "1100000" },
    });
    expect(accountParams.individual).toMatchObject({
      first_name_kana: expect.any(String),
      first_name_kanji: expect.any(String),
      address_kana: expect.objectContaining({ city: "ｶｸｳｼ", town: "ｶｸｳﾁｮｳ" }),
      address_kanji: expect.objectContaining({ city: "架空市", town: "架空町" }),
    });
  });

  it("records not_configured (payment still paid) while Connect is off or the platform profile is unreviewed", async () => {
    const { order, fake } = await setup(5000);
    fake.accountsCreate.mockRejectedValueOnce(connectOff());

    const off = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(off).toMatchObject({ outcome: "not_configured", error: "Stripe Connect not enabled" });
    expect(off.order).toMatchObject({ paymentStatus: "paid", payoutStatus: "not_configured" });
    expect(fake.transfersCreate).not.toHaveBeenCalled();

    fake.accountsCreate.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message:
          "Please review the responsibilities of collecting requirements for connected accounts at https://dashboard.stripe.com/settings/connect/platform-profile.",
      }),
    );
    const profile = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(profile.order).toMatchObject({ payoutStatus: "not_configured", payoutError: PLATFORM_PROFILE_HINT });

    const fixed = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(fixed.order).toMatchObject({ payoutStatus: "paid", payoutError: null });
  });

  it("a definitive refusal moves to a new idempotency key; the retry makes exactly one transfer", async () => {
    const { order, fake } = await setup(3000, { settle: { amount: 3000, net: 2883, currency: "usd" } });
    fake.transferHooks.beforeCommit = () => {
      fake.transferHooks.beforeCommit = undefined;
      throw new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: "Insufficient funds in Stripe account.",
        code: "balance_insufficient",
      });
    };

    const failed = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(failed.order).toMatchObject({
      paymentStatus: "paid",
      payoutStatus: "failed",
      payoutError: "invalid_request_error:balance_insufficient Insufficient funds in Stripe account.",
    });

    const retried = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(retried.outcome).toBe("paid");
    expect(fake.transfersCreate.mock.calls.map((c) => c[1]?.idempotencyKey)).toEqual([
      `pingmarket-payout-${order.id}-0`,
      `pingmarket-payout-${order.id}-1`,
    ]);
    expect(fake.transfers).toHaveLength(1);
  });

  it("an ambiguous error keeps the key; the retry adopts the transfer Stripe already made (no second transfer)", async () => {
    const { order, fake } = await setup(4000, { settle: { amount: 4000, net: 3854, currency: "usd" } });
    // Stripe creates the transfer but the response is lost.
    fake.transferHooks.afterCommit = () => {
      fake.transferHooks.afterCommit = undefined;
      throw new Stripe.errors.StripeConnectionError({ message: "Request timed out" });
    };

    const first = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(first.outcome).toBe("failed");
    expect(first.order.payoutError).toMatch(/retry safe/);
    const [{ attempts }] = await db.select({ attempts: orders.payoutAttempts }).from(orders).where(eq(orders.id, order.id));
    expect(attempts).toBe(0);

    const retried = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(retried).toMatchObject({ outcome: "paid", transferId: "tr_test_1" });
    expect(retried.order).toMatchObject({ payoutStatus: "paid", stripeTransferId: "tr_test_1", payoutAmountCents: 3854 });
    expect(fake.transfersCreate).toHaveBeenCalledTimes(1);
    expect(fake.transfers).toHaveLength(1);
  });

  it("reverses its own transfer if a different one was recorded meanwhile", async () => {
    const { order, fake } = await setup(2600, { settle: { amount: 2600, net: 2500, currency: "usd" } });
    fake.transferHooks.afterCommit = async () => {
      await db
        .update(orders)
        .set({ payoutStatus: "paid", stripeTransferId: "tr_someone_else" })
        .where(eq(orders.id, order.id));
    };
    const result = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(result).toMatchObject({ outcome: "already_paid", transferId: "tr_someone_else" });
    expect(fake.transfersReverse).toHaveBeenCalledWith("tr_test_1");
    expect(fake.transfers[0].reversed).toBe(true);
  });

  it("does not pay out a zero amount, a refunded/disputed/unsucceeded charge, or a session from another account", async () => {
    vi.stubEnv("PLATFORM_FEE_BPS", "10000");
    const zero = await setup(1000);
    const z = await payoutSeller(zero.order.id, { stripe: zero.fake.client, db });
    expect(z.order).toMatchObject({ payoutStatus: "not_configured", payoutError: "Payout amount is 0 (PLATFORM_FEE_BPS=10000)" });
    vi.stubEnv("PLATFORM_FEE_BPS", "0");

    for (const [charge, reason] of [
      [{ refunded: true, amount_refunded: 1000 }, /was refunded/],
      [{ amount_refunded: 200 }, /was refunded/],
      [{ disputed: true }, /is disputed/],
      [{ status: "pending" }, /is pending, not succeeded/],
    ] as const) {
      const s = await setup(1000, { charge });
      const r = await payoutSeller(s.order.id, { stripe: s.fake.client, db });
      expect(r.order.payoutStatus).toBe("failed");
      expect(r.order.payoutError).toMatch(reason);
      expect(r.order.paymentStatus).toBe("paid");
      expect(s.fake.transfersCreate).not.toHaveBeenCalled();
    }

    const missing = await orderForNewSeller(2000);
    const m = await payoutSeller(missing.order.id, { stripe: fakeStripe().client, db });
    expect(m.order.payoutError).toMatch(/Checkout session not found in this Stripe account/);
  });

  it("records unexpected (non-Stripe) errors as failed and releases the claim", async () => {
    const { order, fake } = await setup(1500);
    vi.spyOn(fake.client.accounts, "retrieve").mockRejectedValue(new Error("platform lookup exploded"));
    const result = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(result.outcome).toBe("failed");
    expect(result.order).toMatchObject({ paymentStatus: "paid", payoutStatus: "failed", payoutError: "Error: platform lookup exploded" });
    const [row] = await db.select({ claimed: orders.payoutClaimedAt }).from(orders).where(eq(orders.id, order.id));
    expect(row.claimed).toBeNull();
  });

  it("an in-progress claim blocks other attempts until it is stale", async () => {
    const { order, fake } = await setup(2200);
    await db.update(orders).set({ payoutStatus: "in_progress", payoutClaimedAt: new Date() }).where(eq(orders.id, order.id));
    const blocked = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(blocked).toMatchObject({ outcome: "in_progress", transferId: null });
    expect(fake.sessionsRetrieve).not.toHaveBeenCalled();

    await db
      .update(orders)
      .set({ payoutClaimedAt: new Date(Date.now() - 3 * 60_000) })
      .where(eq(orders.id, order.id));
    expect((await payoutSeller(order.id, { stripe: fake.client, db })).outcome).toBe("paid");
  });

  it("refuses unpaid and unknown orders", async () => {
    const { order, fake } = await setup(2500, {}, false);
    await expect(payoutSeller(order.id, { stripe: fake.client, db })).rejects.toMatchObject({ code: "ORDER_NOT_PAID" });
    await expect(payoutSeller("ORD999999", { stripe: fake.client, db })).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    expect(fake.transfersCreate).not.toHaveBeenCalled();
  });
});

describe("concurrent payout paths on a seller's first sale", () => {
  it("confirm + webhook + payout route at once: one account, one transfer, paid", async () => {
    const { order, sessionId, fake } = await setup(4800, { settle: { amount: 4800, net: 4630, currency: "usd" } });
    const session = (await fake.sessionsRetrieve(sessionId)) as CheckoutSessionSnapshot;

    const results = await Promise.all([
      confirmOrderPayment(order.id, { stripe: fake.client, db }),
      applyPaidCheckoutSession(session, { payoutClient: fake.client, db }),
      payoutSeller(order.id, { stripe: fake.client, db }),
    ]);
    expect(results[0].confirmed).toBe(true);
    expect(fake.accounts).toHaveLength(1);
    expect(fake.transfers).toHaveLength(1);
    expect(await getOrder(order.id, db)).toMatchObject({ payoutStatus: "paid", stripeTransferId: "tr_test_1" });
  });
});

describe("ensureSellerConnectedAccount", () => {
  it("creates the account once with deterministic params, then reuses the stored id", async () => {
    const { sellerId, fake } = await setup(1000, {}, false);
    const first = await ensureSellerConnectedAccount(sellerId, { stripe: fake.client, db });
    const second = await ensureSellerConnectedAccount(sellerId, { stripe: fake.client, db });
    expect(second).toBe(first);
    expect(fake.accountsCreate).toHaveBeenCalledTimes(1);
    const [params, options] = fake.accountsCreate.mock.calls[0];
    expect(params).toMatchObject({
      type: "custom",
      country: "US",
      external_account: "btok_us_verified",
      metadata: { pingmarketUserId: sellerId },
      individual: { address: { line1: "address_full_match" }, dob: { year: 1902 } },
    });
    const minute = Number(options?.idempotencyKey?.split("-").pop());
    expect(options?.idempotencyKey).toBe(`pingmarket-seller-${sellerId}-${minute}`);
    expect(params.tos_acceptance?.date).toBe(minute * 60);
    expect(testAccountParams(sellerId, { country: "US", currency: "usd" }, minute)).toEqual(params);
    const [row] = await db.select({ acct: users.stripeAccountId }).from(users).where(eq(users.id, sellerId));
    expect(row.acct).toBe(first);
  });

  it("adopts an account Stripe already has for the user instead of creating another", async () => {
    const { sellerId, fake } = await setup(1000, {}, false);
    fake.accounts.push({ id: "acct_orphan_from_lost_response", metadata: { pingmarketUserId: sellerId } });
    expect(await ensureSellerConnectedAccount(sellerId, { stripe: fake.client, db })).toBe("acct_orphan_from_lost_response");
    expect(fake.accountsCreate).not.toHaveBeenCalled();
  });

  it("deletes its own new account when another writer stored one first", async () => {
    const { sellerId, fake } = await setup(1000, {}, false);
    fake.accountsCreate.mockImplementationOnce(async () => {
      await db.update(users).set({ stripeAccountId: "acct_winner" }).where(eq(users.id, sellerId));
      return { id: "acct_loser" };
    });
    expect(await ensureSellerConnectedAccount(sellerId, { stripe: fake.client, db })).toBe("acct_winner");
    expect(fake.accountsDel).toHaveBeenCalledWith("acct_loser");
  });

  it("refuses non-test keys and unsupported platform countries", async () => {
    const { sellerId, fake } = await setup(1000, {}, false);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_never");
    const err = await ensureSellerConnectedAccount(sellerId, { stripe: fake.client, db }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderError);
    expect((err as OrderError).code).toBe("STRIPE_NOT_CONFIGURED");
    expect(fake.accountsCreate).not.toHaveBeenCalled();
    expect(() => testAccountParams(sellerId, { country: "FR", currency: "eur" })).toThrow(/No test seller data/);
  });

  it("maps Stripe's Connect setup refusals by message", () => {
    expect(connectUnavailableReason(connectOff())).toBe("Stripe Connect not enabled");
    expect(
      connectUnavailableReason(
        new Stripe.errors.StripeInvalidRequestError({
          message:
            "Please review the responsibilities of collecting requirements for connected accounts at https://dashboard.stripe.com/settings/connect/platform-profile.",
        }),
      ),
    ).toBe(PLATFORM_PROFILE_HINT);
    expect(connectUnavailableReason(new Stripe.errors.StripeAPIError({ message: "boom" }))).toBeNull();
    expect(connectUnavailableReason(new Error("signed up for Connect"))).toBeNull();
  });
});

describe("payout hooks on payment confirmation", () => {
  it("confirm marks paid and pays the seller; confirm on a paid order retries a not_configured payout", async () => {
    const { order, fake } = await setup(4200, { settle: { amount: 4200, net: 4048, currency: "usd" } }, false);
    fake.accountsCreate.mockRejectedValueOnce(connectOff());

    const first = await confirmOrderPayment(order.id, { stripe: fake.client, db });
    expect(first.confirmed).toBe(true);
    expect(first.order).toMatchObject({ paymentStatus: "paid", payoutStatus: "not_configured" });

    // Operator enabled Connect: confirming again (e.g. "Check payment status") retries the payout.
    const second = await confirmOrderPayment(order.id, { stripe: fake.client, db });
    expect(second.order).toMatchObject({ paymentStatus: "paid", payoutStatus: "paid", payoutAmountCents: 4048 });
    expect(fake.transfersCreate).toHaveBeenCalledTimes(1);

    // Fully done: nothing else is sent to Stripe.
    fake.sessionsRetrieve.mockClear();
    await confirmOrderPayment(order.id, { stripe: fake.client, db });
    expect(fake.sessionsRetrieve).not.toHaveBeenCalled();
  });

  it("a deferred scheduler gets the payout instead of the request (as `after` does in routes)", async () => {
    const { order, fake } = await setup(3900, { settle: { amount: 3900, net: 3757, currency: "usd" } }, false);
    const deferred: (() => Promise<void>)[] = [];
    const result = await confirmOrderPayment(order.id, {
      stripe: fake.client,
      db,
      schedule: (task) => {
        deferred.push(task);
      },
    });
    expect(result.confirmed).toBe(true);
    expect(result.order.payoutStatus).toBe("not_started");
    expect(fake.transfersCreate).not.toHaveBeenCalled();
    await Promise.all(deferred.map((task) => task()));
    expect((await getOrder(order.id, db))?.payoutStatus).toBe("paid");
  });
});
