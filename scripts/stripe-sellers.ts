/**
 * Provisions Stripe Connect TEST connected accounts for every seller and prints their transfer capability.
 *   npm run stripe:sellers                    # get-or-create accounts
 *   npm run stripe:sellers -- --payout-pending  # also retry seller payouts for paid orders
 * Uses the same database as the app (getDb()). With the embedded PGlite database, stop `npm run dev`
 * first (only one process may open ./.pglite) or call POST /api/stripe/sellers on the running server.
 */
import { getDb, isEmbeddedDb } from "../src/lib/db";
import { isStripeConfigured } from "../src/lib/payments/stripe";
import { payoutPendingOrders, provisionSellerAccounts } from "../src/lib/payments/payouts";

const port = process.env.PORT ?? "3000";

async function devServerIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/marketplaces`, { signal: AbortSignal.timeout(1500) });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function main() {
  if (!isStripeConfigured()) {
    console.error("STRIPE_SECRET_KEY is missing or not a test-mode key (sk_test_/rk_test_). Set it in .env.local.");
    process.exit(1);
  }
  if (isEmbeddedDb() && (await devServerIsUp())) {
    console.error(
      `A dev server is running on :${port} and holds the embedded database (./.pglite), which only one process can open.\n` +
        `Either stop \`npm run dev\` and rerun this script, or call the running server instead:\n` +
        `  curl -X POST http://localhost:${port}/api/stripe/sellers\n` +
        `  curl -X POST http://localhost:${port}/api/orders/<ORDER_ID>/payout`,
    );
    process.exit(2);
  }

  let db;
  try {
    db = await getDb();
  } catch (err) {
    console.error(
      `Could not open the database${isEmbeddedDb() ? " (./.pglite may be in use by another process; stop `npm run dev`)" : ""}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    process.exit(2);
  }

  const { connectEnabled, sellers } = await provisionSellerAccounts({ db });
  for (const s of sellers) {
    console.log(
      s.accountId
        ? `${s.userId} -> ${s.accountId} (capabilities.transfers: ${s.transfers ?? "unknown"})`
        : `${s.userId} -> no account: ${s.error}`,
    );
  }
  if (!connectEnabled) {
    console.log("\nStripe Connect is not enabled on this sandbox yet. Enable it (Dashboard → Connect → Get started), then rerun.");
  }

  if (process.argv.includes("--payout-pending")) {
    const results = await payoutPendingOrders({ db });
    if (results.length === 0) console.log("\nNo paid orders are waiting for a seller payout.");
    for (const r of results) {
      console.log(
        `${r.order.id}: ${r.outcome}` +
          (r.transferId ? ` ${r.transferId} ($${((r.order.payoutAmountCents ?? 0) / 100).toFixed(2)})` : "") +
          (r.error ? ` (${r.error})` : ""),
      );
    }
  }
  process.exit(0);
}

void main();
