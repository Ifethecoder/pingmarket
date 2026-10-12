/**
 * Adds a batch of sample Stripe TEST transactions so the marketplace money flow is visible in the Stripe Dashboard:
 *   - money received: buyer card payments to the platform (USD, settled in the platform currency, like Checkout)
 *   - money paid: seller payouts as Connect transfers funded by each charge (same as payouts.ts), plus one buyer refund
 *   npm run stripe:samples
 *   PLATFORM_FEE_BPS=1000 npm run stripe:samples   # keep a 10% platform fee on each sale
 * Stripe only, no database: safe to run while `npm run dev` is up. Sample sellers are reused across runs;
 * every run adds a new batch of payments tagged with `metadata.sampleRun`.
 */
import Stripe from "stripe";
import {
  connectUnavailableReason,
  getPlatformAccount,
  platformFeeBps,
  splitSale,
  testAccountParams,
} from "../src/lib/payments/payouts";
import { getStripe, isStripeConfigured } from "../src/lib/payments/stripe";

const SELLERS = [
  { userId: "sample_seller_aiko", name: "Aiko's Gadgets (sample seller)" },
  { userId: "sample_seller_ben", name: "Ben's Bikes (sample seller)" },
  { userId: "sample_seller_chen", name: "Chen Camera Co (sample seller)" },
];

/** `card` = Stripe test PaymentMethod (docs.stripe.com/testing). `refund` = buyer cancelled before the payout. */
const SALES = [
  { item: "iPhone 13 Pro Max 256GB", cents: 52_000, card: "pm_card_visa", seller: 0 },
  { item: "Trek FX 2 hybrid bike", cents: 38_500, card: "pm_card_mastercard", seller: 1 },
  { item: "Nintendo Switch OLED", cents: 24_000, card: "pm_card_amex", seller: 0 },
  { item: "Canon EOS R50 kit", cents: 69_900, card: "pm_card_jcb", seller: 2 },
  { item: "Sony WH-1000XM5 headphones", cents: 21_500, card: "pm_card_visa_debit", seller: 2 },
  { item: "Brompton C Line folding bike", cents: 145_000, card: "pm_card_bypassPending", seller: 1 },
  { item: "iPad Air M2", cents: 49_900, card: "pm_card_mastercard_debit", seller: 0, refund: true },
];

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    currency === "jpy" ? minor : minor / 100,
  );

/** Finds the sample seller's connected account from a previous run, or creates a Custom test account. */
async function ensureSampleSeller(
  stripe: Stripe,
  existing: Map<string, Stripe.Account>,
  seller: (typeof SELLERS)[number],
): Promise<Stripe.Account> {
  let account = existing.get(seller.userId);
  if (!account) {
    const params = testAccountParams(seller.userId, await getPlatformAccount(stripe));
    account = await stripe.accounts.create(
      {
        ...params,
        business_profile: { ...params.business_profile, name: seller.name },
        metadata: { ...params.metadata, pingmarketSample: "true" },
      },
      { idempotencyKey: `pingmarket-sample-seller-${seller.userId}-${Math.floor(Date.now() / 60_000)}` },
    );
  }
  // Test accounts verify within seconds; transfers are refused until the capability is active.
  for (let i = 0; account.capabilities?.transfers !== "active" && i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    account = await stripe.accounts.retrieve(account.id);
  }
  return account;
}

async function main() {
  if (!isStripeConfigured()) {
    console.error("STRIPE_SECRET_KEY is missing or not a test-mode key (sk_test_/rk_test_). Set it in .env.local.");
    process.exit(1);
  }
  const stripe = getStripe();
  const platform = await getPlatformAccount(stripe);
  const bps = platformFeeBps();
  const runId = `sample-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
  console.log(`Platform ${platform.country}/${platform.currency.toUpperCase()}, fee ${bps / 100}%, run ${runId}\n`);

  const existing = new Map<string, Stripe.Account>();
  for await (const acct of stripe.accounts.list({ limit: 100 })) {
    const userId = acct.metadata?.pingmarketUserId;
    if (acct.metadata?.pingmarketSample === "true" && userId) existing.set(userId, acct);
  }
  const accounts: Stripe.Account[] = [];
  for (const seller of SELLERS) {
    try {
      const account = await ensureSampleSeller(stripe, existing, seller);
      accounts.push(account);
      console.log(`seller ${seller.userId} -> ${account.id} (transfers: ${account.capabilities?.transfers ?? "unknown"})`);
    } catch (err) {
      const reason = connectUnavailableReason(err);
      console.error(`seller ${seller.userId}: ${reason ?? (err instanceof Error ? err.message : String(err))}`);
      process.exit(2);
    }
  }
  console.log();

  let receivedUsd = 0;
  let receivedSettled = 0;
  let paidOut = 0;
  let refunded = 0;
  let failures = 0;
  for (const [i, sale] of SALES.entries()) {
    const orderId = `${runId}-${i + 1}`;
    const seller = SELLERS[sale.seller];
    const destination = accounts[sale.seller];
    const metadata = { sampleRun: runId, orderId, sellerId: seller.userId, item: sale.item };
    try {
      const intent = await stripe.paymentIntents.create(
        {
          amount: sale.cents,
          currency: "usd",
          payment_method: sale.card,
          payment_method_types: ["card"],
          confirm: true,
          description: `PingMarket sample order: ${sale.item}`,
          transfer_group: orderId,
          metadata,
          expand: ["latest_charge.balance_transaction"],
        },
        { idempotencyKey: `pingmarket-${orderId}-charge` },
      );
      const charge = intent.latest_charge as Stripe.Charge | null;
      const balance = charge?.balance_transaction as Stripe.BalanceTransaction | null;
      if (intent.status !== "succeeded" || !charge || !balance) {
        throw new Error(`payment ${intent.id} is ${intent.status}`);
      }
      receivedUsd += sale.cents;
      receivedSettled += balance.amount;
      let line = `IN  ${intent.id}  ${money(sale.cents, "usd").padStart(10)} (${money(balance.amount, balance.currency)})  ${sale.item}`;

      if (sale.refund) {
        const refund = await stripe.refunds.create(
          { payment_intent: intent.id, reason: "requested_by_customer", metadata },
          { idempotencyKey: `pingmarket-${orderId}-refund` },
        );
        refunded += balance.amount;
        line += `\nOUT ${refund.id}  refund to buyer ${money(sale.cents, "usd")} (buyer cancelled)`;
      } else {
        const { payoutCents } = splitSale(balance.amount, bps);
        const transfer = await stripe.transfers.create(
          {
            amount: payoutCents,
            currency: balance.currency,
            destination: destination.id,
            transfer_group: orderId,
            source_transaction: charge.id,
            description: `Seller payout: ${sale.item}`,
            metadata,
          },
          { idempotencyKey: `pingmarket-${orderId}-transfer` },
        );
        paidOut += payoutCents;
        line += `\nOUT ${transfer.id}  ${money(payoutCents, balance.currency).padStart(10)} -> ${seller.userId} (${destination.id})`;
      }
      console.log(line);
    } catch (err) {
      failures++;
      console.error(`ERR ${orderId} ${sale.item}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const c = platform.currency;
  console.log(
    `\nReceived from buyers: ${money(receivedUsd, "usd")} (${money(receivedSettled, c)} settled)` +
      `\nPaid to sellers:      ${money(paidOut, c)}` +
      `\nRefunded to buyers:   ${money(refunded, c)}` +
      `\nPlatform kept:        ${money(receivedSettled - paidOut - refunded, c)} (before Stripe fees)` +
      `\n\nDashboard (test mode): https://dashboard.stripe.com/test/payments  ·  /test/connect/transfers` +
      `\nFilter by metadata sampleRun = ${runId}`,
  );
  process.exit(failures ? 1 : 0);
}

void main();
