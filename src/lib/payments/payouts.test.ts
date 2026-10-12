import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db";
import { offers, users } from "../db/schema";
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
import { confirmOrderPayment, type CheckoutSessionSnapshot, type StripeCheckoutClient } from "./stripe";

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
    message: "You can only create new accounts if you've signed up for Connect, which you can do at https://dashboard.stripe.com/connect.",
  });

/**
 * Fake Stripe covering Checkout (confirm) and payouts. Every session is paid; its expanded charge settles
 * `settle` (amount/currency of the balance transaction, e.g. USD charge settling in JPY).
 */
function fakeStripe({
  country = "US",
  currency = "usd",
  settle = { amount: 11000, currency: "usd" },
}: { country?: string; currency?: string; settle?: { amount: number; currency: string } } = {}) {
  let transferSeq = 0;
  const sessions = new Map<string, { orderId: string; amount: number }>();
  // Connected account ids are unique per seller (as on Stripe), so fakes never collide in the shared DB.
  const accountsCreate = vi.fn(async (params: Stripe.AccountCreateParams, options?: Stripe.RequestOptions) => {
    void options;
    return { id: `acct_${(params.metadata as Record<string, string>).pingmarketUserId}` };
  });
  const accountsRetrieve = vi.fn(async (id: string | null) =>
    id === null
      ? { id: "acct_platform", country, default_currency: currency, capabilities: undefined }
      : { id, country, default_currency: currency, capabilities: { transfers: "active" as const } },
  );
  const transfersCreate = vi.fn(async (params: Stripe.TransferCreateParams, options?: Stripe.RequestOptions) => {
    void params;
    void options;
    return { id: `tr_test_${++transferSeq}` };
  });
  const sessionsRetrieve = vi.fn(async (id: string, params?: Stripe.Checkout.SessionRetrieveParams) => {
    void params;
    const known = sessions.get(id);
    if (!known) {
      throw new Stripe.errors.StripeInvalidRequestError({ message: `No such checkout.session: '${id}'`, code: "resource_missing" });
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
      latest_charge: { id: `ch_${id}`, balance_transaction: { id: `txn_${id}`, ...settle } },
    } as unknown as Stripe.PaymentIntent;
    return { ...snapshot, payment_intent };
  });
  const client: StripePayoutClient & StripeCheckoutClient = {
    accounts: { create: accountsCreate, retrieve: accountsRetrieve },
    transfers: { create: transfersCreate },
    checkout: {
      sessions: {
        retrieve: sessionsRetrieve,
        create: vi.fn(),
        expire: vi.fn(),
      },
    },
  };
  return { client, accountsCreate, accountsRetrieve, transfersCreate, sessionsRetrieve, sessions };
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

describe("fees", () => {
  it("splits with integer basis points (default 0, clamped 0..10000)", () => {
    expect(platformFeeBps()).toBe(0);
    expect(splitSale(11000, 0)).toEqual({ feeCents: 0, payoutCents: 11000 });
    expect(splitSale(11000, 250)).toEqual({ feeCents: 275, payoutCents: 10725 });
    expect(splitSale(16_489, 1000)).toEqual({ feeCents: 1649, payoutCents: 14_840 });
    vi.stubEnv("PLATFORM_FEE_BPS", "-5");
    expect(platformFeeBps()).toBe(0);
    vi.stubEnv("PLATFORM_FEE_BPS", "20000");
    expect(platformFeeBps()).toBe(10_000);
    vi.stubEnv("PLATFORM_FEE_BPS", "abc");
    expect(platformFeeBps()).toBe(0);
  });
});

describe("payoutSeller", () => {
  it("transfers the settled amount once: destination, source_transaction, transfer_group, idempotency key", async () => {
    const { order, sellerId, sessionId } = await orderForNewSeller(11000);
    const fake = fakeStripe();
    fake.sessions.set(sessionId, { orderId: order.id, amount: 11000 });

    const result = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(result.outcome).toBe("paid");
    expect(fake.transfersCreate).toHaveBeenCalledTimes(1);
    const [params, options] = fake.transfersCreate.mock.calls[0];
    expect(params).toEqual({
      amount: 11000,
      currency: "usd",
      destination: `acct_${sellerId}`,
      transfer_group: order.id,
      source_transaction: `ch_${sessionId}`,
      metadata: { orderId: order.id, offerId: order.offerId, sellerId },
    });
    expect(options).toEqual({ idempotencyKey: `pingmarket-payout-${order.id}-0` });
    expect(fake.sessionsRetrieve).toHaveBeenCalledWith(sessionId, {
      expand: ["payment_intent.latest_charge.balance_transaction"],
    });
    expect(result.order).toMatchObject({
      paymentStatus: "paid",
      payoutStatus: "paid",
      stripeTransferId: "tr_test_1",
      stripePaymentIntentId: `pi_${sessionId}`,
      payoutAmountCents: 11000,
      platformFeeCents: 0,
      payoutCurrency: "usd",
      payoutError: null,
    });
    expect(result.order.payoutAt).not.toBeNull();

    // Already paid out: no Stripe call at all.
    const again = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(again).toMatchObject({ outcome: "already_paid", transferId: "tr_test_1" });
    expect(fake.transfersCreate).toHaveBeenCalledTimes(1);
    expect(fake.sessionsRetrieve).toHaveBeenCalledTimes(1);
    expect(fake.accountsCreate).toHaveBeenCalledTimes(1);
  });

  it("pays a JP platform's seller in JPY from the balance transaction, minus the fee", async () => {
    vi.stubEnv("PLATFORM_FEE_BPS", "1000");
    const { order, sessionId } = await orderForNewSeller(11000);
    const fake = fakeStripe({ country: "JP", currency: "jpy", settle: { amount: 16_489, currency: "jpy" } });
    fake.sessions.set(sessionId, { orderId: order.id, amount: 11000 });

    const result = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(fake.transfersCreate.mock.calls[0][0]).toMatchObject({ amount: 14_840, currency: "jpy" });
    expect(result.order).toMatchObject({ payoutAmountCents: 14_840, platformFeeCents: 1649, payoutCurrency: "jpy" });

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
      last_name_kana: expect.any(String),
      last_name_kanji: expect.any(String),
      address_kana: expect.objectContaining({ postal_code: "1500001", town: expect.any(String) }),
      address_kanji: expect.objectContaining({ state: "東京都", town: expect.any(String) }),
    });
  });

  it("records not_configured (payment still paid) while Connect is off or the platform profile is unreviewed", async () => {
    const { order, sessionId } = await orderForNewSeller(5000);
    const fake = fakeStripe();
    fake.sessions.set(sessionId, { orderId: order.id, amount: 5000 });
    fake.accountsCreate.mockRejectedValueOnce(connectOff());

    const off = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(off).toMatchObject({ outcome: "not_configured", error: "Stripe Connect not enabled" });
    expect(off.order).toMatchObject({ paymentStatus: "paid", payoutStatus: "not_configured", payoutError: "Stripe Connect not enabled" });
    expect(fake.transfersCreate).not.toHaveBeenCalled();

    fake.accountsCreate.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({
        message:
          "Please review the responsibilities of collecting requirements for connected accounts at https://dashboard.stripe.com/settings/connect/platform-profile.",
      }),
    );
    const profile = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(profile.order).toMatchObject({ payoutStatus: "not_configured", payoutError: PLATFORM_PROFILE_HINT });

    // After the operator fixes Stripe, the retry pays.
    const fixed = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(fixed.order).toMatchObject({ payoutStatus: "paid", payoutError: null });
  });

  it("records a failed transfer with a short error, then retries with a fresh idempotency key", async () => {
    const { order, sessionId } = await orderForNewSeller(3000);
    const fake = fakeStripe({ settle: { amount: 3000, currency: "usd" } });
    fake.sessions.set(sessionId, { orderId: order.id, amount: 3000 });
    fake.transfersCreate.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: "Insufficient funds in Stripe account.",
        code: "balance_insufficient",
      }),
    );

    const failed = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(failed.outcome).toBe("failed");
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
  });

  it("fails cleanly (no throw) when the order's Checkout session is not in this Stripe account", async () => {
    const { order } = await orderForNewSeller(2000);
    const fake = fakeStripe();
    const result = await payoutSeller(order.id, { stripe: fake.client, db });
    expect(result.outcome).toBe("failed");
    expect(result.order.payoutError).toMatch(/Checkout session not found in this Stripe account/);
    expect(result.order.paymentStatus).toBe("paid");
  });

  it("refuses unpaid and unknown orders", async () => {
    const { order } = await orderForNewSeller(2500, { paid: false });
    const fake = fakeStripe();
    await expect(payoutSeller(order.id, { stripe: fake.client, db })).rejects.toMatchObject({ code: "ORDER_NOT_PAID" });
    await expect(payoutSeller("ORD999999", { stripe: fake.client, db })).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    expect(fake.transfersCreate).not.toHaveBeenCalled();
  });
});

describe("ensureSellerConnectedAccount", () => {
  it("creates the account once, then reuses the stored id", async () => {
    const { sellerId } = await orderForNewSeller(1000, { paid: false });
    const fake = fakeStripe();
    const first = await ensureSellerConnectedAccount(sellerId, { stripe: fake.client, db });
    const second = await ensureSellerConnectedAccount(sellerId, { stripe: fake.client, db });
    expect(first).toBe(`acct_${sellerId}`);
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
    expect(options?.idempotencyKey).toMatch(new RegExp(`^pingmarket-seller-${sellerId}-\\d+$`));
    const [row] = await db.select({ acct: users.stripeAccountId }).from(users).where(eq(users.id, sellerId));
    expect(row.acct).toBe(`acct_${sellerId}`);
  });

  it("refuses non-test keys and unsupported platform countries", async () => {
    const { sellerId } = await orderForNewSeller(1000, { paid: false });
    const fake = fakeStripe();
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
          message: "Please review the responsibilities of collecting requirements for connected accounts at https://dashboard.stripe.com/settings/connect/platform-profile.",
        }),
      ),
    ).toBe(PLATFORM_PROFILE_HINT);
    expect(connectUnavailableReason(new Stripe.errors.StripeAPIError({ message: "boom" }))).toBeNull();
    expect(connectUnavailableReason(new Error("signed up for Connect"))).toBeNull();
  });
});

describe("payout hooks on payment confirmation", () => {
  it("confirm marks paid and pays the seller; confirm on a paid order retries a failed payout", async () => {
    const { order, sessionId } = await orderForNewSeller(4200, { paid: false });
    const fake = fakeStripe({ settle: { amount: 4200, currency: "usd" } });
    fake.sessions.set(sessionId, { orderId: order.id, amount: 4200 });
    fake.accountsCreate.mockRejectedValueOnce(connectOff());

    const first = await confirmOrderPayment(order.id, { stripe: fake.client, db });
    expect(first.confirmed).toBe(true);
    expect(first.order).toMatchObject({ paymentStatus: "paid", payoutStatus: "not_configured" });

    // Operator enabled Connect: confirming again (e.g. "Check payment status") retries the payout.
    const second = await confirmOrderPayment(order.id, { stripe: fake.client, db });
    expect(second.order).toMatchObject({ paymentStatus: "paid", payoutStatus: "paid", payoutAmountCents: 4200 });
    expect(fake.transfersCreate).toHaveBeenCalledTimes(1);

    // Fully done: nothing else is sent to Stripe.
    fake.sessionsRetrieve.mockClear();
    await confirmOrderPayment(order.id, { stripe: fake.client, db });
    expect(fake.sessionsRetrieve).not.toHaveBeenCalled();
    expect((await getOrder(order.id, db))?.stripeTransferId).toBe("tr_test_1");
  });
});
