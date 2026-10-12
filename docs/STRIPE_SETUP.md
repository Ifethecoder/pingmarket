# Stripe test-mode checkout (PM-11)

PingMarket takes one agreed price through a **hosted Stripe Checkout page in test mode (sandbox)**. **Only `STRIPE_SECRET_KEY` is required**: when the buyer comes back from Checkout, the server reads the Checkout Session from Stripe with the secret key and marks the order `paid` only if Stripe says it is paid. A signed webhook is an optional backstop. Generating the link, opening it, or the redirect URL alone never marks anything paid. Every completed sale then makes a **second** test transaction: a Stripe Connect transfer from the platform to the seller's test connected account (see [Seller payouts](#seller-payouts-stripe-connect-test-mode)). No live payouts, no real money.

## 1. Secret key

1. Open the [Stripe Dashboard](https://dashboard.stripe.com) and switch to your **Sandbox** (newer dashboards) or turn on **Test mode** (older dashboards, toggle at the top right).
2. Go to **Developers → API keys** and copy the **Secret key** (`sk_test_…`). A restricted test key (`rk_test_…`) with write access to Checkout Sessions also works.
3. Put it in `.env.local`:

   ```bash
   STRIPE_SECRET_KEY=sk_test_...
   ```

Live keys (`sk_live_…`) are refused: the app reports `STRIPE_NOT_CONFIGURED`. Never commit `.env.local`, and never paste keys into issues, chat or logs.

That is all the default flow needs. Restart `npm run dev` after editing `.env.local`.

## 2. Optional: webhook backstop

Not required. Without it, payment is confirmed when the buyer returns from Checkout, or on demand with **Check payment status**. The webhook additionally catches buyers who close the tab before Stripe redirects them back, and delayed payment methods (bank debits) that settle later. The endpoint is `POST /api/stripe/webhook`; without `STRIPE_WEBHOOK_SECRET` it answers `503`, which is harmless when no webhook is configured.

### Local development (Stripe CLI)

1. Install the [Stripe CLI](https://docs.stripe.com/stripe-cli) and run `stripe login` once.
2. With `npm run dev` running, start forwarding in a second terminal:

   ```bash
   npm run stripe:listen
   # = stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```

3. The CLI prints `Your webhook signing secret is whsec_…`. Copy it into `.env.local`:

   ```bash
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```

4. Restart `npm run dev` so it reads the new value. The CLI secret usually stays the same across `stripe listen` runs on the same machine; if it changes, update `.env.local` again.

### Deployed URL (Stripe Dashboard)

1. Make sure you are in test mode. Newer dashboards may show a **Sandbox** switcher instead of a "Test mode" toggle; either works.
2. Add an endpoint. Newer dashboards: **Workbench → Webhooks** (also labelled **Event destinations**) **→ Add destination**, choose "Webhook endpoint". Older dashboards: **Developers → Webhooks → Add endpoint**.
3. Endpoint URL: `https://<your-host>/api/stripe/webhook`.
4. Select these events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - (optional) `checkout.session.expired`: acknowledged; the order stays `pending`.
5. After saving, reveal the endpoint's **Signing secret** (`whsec_…`) and set it as `STRIPE_WEBHOOK_SECRET` in the deployment's environment.
6. Whether or not you add the webhook, set `APP_URL=https://<your-host>` in the deployment's environment. It is server-only and read at runtime. In production, checkout refuses to start without it (`503 APP_URL_REQUIRED`), so a forged `Host` header can never choose where Stripe redirects the buyer. In development the request origin is used when it is unset.

## 3. Demo flow (secret key only)

1. `npm run dev` with `STRIPE_SECRET_KEY` set. No `stripe listen` needed.
2. On `/dashboard`, send an offer on a native listing and get it to `accepted` (via the negotiation flow).
3. In the **Negotiation** panel the accepted offer shows **Pay with Stripe (test)**. Clicking it:
   - `POST /api/orders { offerId }` gets or creates the order (`ORD{n}`, `pending`, amount = accepted price);
   - `POST /api/orders/{id}/checkout` creates (or reuses, while still open) a hosted Checkout Session;
   - the browser goes to Stripe's hosted page.
4. Pay with the test card **4242 4242 4242 4242**, any future expiry date, any CVC and any postal code.
5. Stripe redirects to `/dashboard?checkout=success&order=ORD{n}&session_id=cs_test_…` (Stripe fills in the real session id). The dashboard removes the query string and calls `POST /api/orders/ORD{n}/confirm { sessionId }`. The server retrieves that session from Stripe with the secret key and checks it (see the rules below). If it is paid, the order becomes `paid` and the listing `sold` in one transaction, the toast says "Payment confirmed — order ORD{n} paid", and the panel shows a **Paid** chip. The event trace shows `Order ORD{n} paid via Stripe test checkout`.
6. If Stripe has not settled yet, the dashboard retries 3 more times, 2 seconds apart, then says "Payment not confirmed yet — use Check payment status". That button (shown for a pending order that has a Checkout session) runs the same server check on demand.

Cancelling on the Stripe page returns to `?checkout=cancel`; the order stays `pending` and the button can be used again (the still-open session is reused).

If the buyer paid but the order is still `pending` (for example the tab was closed before the redirect), clicking **Pay** again does **not** create a second session: the server checks the completed session with Stripe first. If it is paid, the order is marked `paid` and the API answers `409 ORDER_NOT_PENDING` ("Order already paid"); if it is still settling, it answers `409 PAYMENT_PROCESSING` and the panel shows "Payment received, awaiting confirmation…" with **Check payment status**. A `failed` order shows **Retry payment**, which starts a fresh session and moves the order back to `pending`.

## Rules for marking an order paid

Every path (the confirm endpoint, a repeated Pay click, and the optional webhook) uses the same check, `applyPaidCheckoutSession` in `src/lib/payments/stripe.ts`, on a Checkout Session that came from Stripe itself (retrieved with the secret key, or inside a signed webhook). All of these must hold:

- `livemode` is `false` (test mode / sandbox only);
- the session's order (`client_reference_id`, falling back to `metadata.orderId`) exists and, for `POST /api/orders/{id}/confirm`, is that same order. A `sessionId` belonging to another order is rejected with `409 SESSION_MISMATCH` and changes nothing;
- `payment_status` is `"paid"` (otherwise the order stays `pending`);
- `amount_total` equals the order amount and `currency` is `usd`. Otherwise the check is logged and the order is not marked paid (`reason: "amount_mismatch"`).

Then the order goes `pending`/`failed` → `paid`, records the paid session id, and the listing becomes `sold`. Repeating it is a no-op. If an already-paid order sees a second, different paid session, that is logged as a conflict (possible double payment, refund it in the Stripe Dashboard) and nothing changes.

`POST /api/orders/{id}/confirm`, optional body `{ "sessionId": "cs_test_…" }` (defaults to the order's stored session):

| Situation | Response |
|---|---|
| order already `paid` | `200 { confirmed: true }`, Stripe is not called |
| session paid and all checks pass | `200 { confirmed: true, sessionStatus: "complete", paymentStatus: "paid" }` |
| session open / unpaid | `200 { confirmed: false, sessionStatus, paymentStatus }` |
| checks fail (live mode, amount, currency) | `200 { confirmed: false, reason }` |
| order has no session yet | `200 { confirmed: false, reason: "no_session" }` |
| unknown order / session | `404 ORDER_NOT_FOUND` / `404 SESSION_NOT_FOUND` |
| session belongs to another order | `409 SESSION_MISMATCH` |
| no test-mode secret key | `503 STRIPE_NOT_CONFIGURED` |

Optional webhook events:

| Event | Effect |
|---|---|
| `checkout.session.completed`, `payment_status = "paid"` | `pending → paid`, listing → `sold` |
| `checkout.session.completed`, `payment_status = "unpaid"` (async method) | stays `pending` until the async result arrives |
| `checkout.session.async_payment_succeeded` | `pending → paid`, listing → `sold` |
| `checkout.session.async_payment_failed` | `pending → failed` |
| `checkout.session.expired` | stays `pending`; the next click creates a new session |
| any other event | `200 { received: true, ignored: true }` |

- Duplicate deliveries are no-ops (`changed: false`). Events that can never apply (live mode, unknown order, amount mismatch, second payment) get a `200` acknowledgement so Stripe stops retrying; database errors return `500` so Stripe retries.
- Bad or missing signatures get `400`. The raw body and card data are never logged; card details only ever exist on Stripe's hosted page.

## Seller payouts (Stripe Connect, test mode)

Each paid order produces two sandbox transactions, using Connect **separate charges and transfers**:

1. the buyer's **payment**: the hosted Checkout charge on the platform, in USD;
2. a **transfer to the seller**: from the platform to the seller's Custom test connected account. It is funded by that same charge (`source_transaction`), so it works even when the platform's available test balance is 0 or pending. It is grouped with the charge by `transfer_group` = order id (Checkout sets `payment_intent_data.transfer_group`).

The payout runs automatically right after the payment is confirmed. That covers the return from Checkout, **Check payment status**, a repeated **Pay** click, and the optional webhook. A payout problem never affects the payment: the order stays `paid` and the payout state is shown next to it.

### Enable Connect in the sandbox (one-time, in the Stripe Dashboard)

1. In your **Sandbox** (or test mode), open **Connect → Get started** and choose a platform / marketplace setup.
2. Review the platform profile at **Settings → Connect → Platform profile** (`dashboard.stripe.com/settings/connect/platform-profile`). This covers who collects requirements for connected accounts and who is liable for losses. Until it is done, Stripe refuses Custom account creation, and the app records `Review Connect platform profile: …`.
3. If Stripe answers that Accounts v1 is not supported for new integrations, enable **Accounts v1 support** under **Settings → Developers → API policies**. The app creates Custom accounts with the v1 Accounts API.

Then provision the sellers' accounts. You can skip this step, because the first payout does it:

```bash
curl -X POST http://localhost:3000/api/stripe/sellers      # against the running dev server
npm run stripe:sellers                                      # or as a script (stop `npm run dev` first)
npm run stripe:sellers -- --payout-pending                  # also retry payouts of paid orders
```

Each seller gets one connected account in **the platform's country** (cross-border transfers are not available to every platform). It is created with Stripe's documented test values, so no onboarding is needed:

- **US platform:** test DOB / ID number, `address_full_match`, and `btok_us_verified`.
- **JP platform:** kana and kanji name and address, the identity-document test token `file_identity_document_success`, and test bank `1100000` / `0001234`.

The account id is stored on the user (`users.stripe_account_id`) and reused.

### Amounts and currency

The buyer pays in USD (the app's prices). The transfer is made in the platform's **settlement currency**, using the charge's balance transaction. For a JP platform, a $110.00 charge settles as about ¥16,000. The transfer is that settled gross amount minus `PLATFORM_FEE_BPS` (basis points, default `0`; `250` = 2.5%), rounded to whole minor units. The order records `payout_amount_cents` (minor units, so yen for JPY), `payout_currency`, `platform_fee_cents`, `stripe_transfer_id` and `stripe_payment_intent_id`.

### Payout states

| `payout_status` | Meaning | Dashboard |
|---|---|---|
| `not_started` | payment not confirmed yet, or no test key | — |
| `not_configured` | Connect not enabled / platform profile not reviewed | "Seller payout: enable Stripe Connect" |
| `failed` | Stripe refused the transfer or account (short reason in `payout_error`) | "Seller payout failed" + **Retry payout** |
| `paid` | transfer created | "Seller paid ¥…" |

Retry with **Retry payout**, **Check payment status**, `POST /api/orders/{id}/payout`, or `npm run stripe:sellers -- --payout-pending`. Retries never create a second transfer. Concurrent attempts share one idempotency key; a new key is used only after a recorded failure, because Stripe replays a failed request's error for 24 hours.

### Where to see the two transactions in the Stripe Dashboard (sandbox)

- Buyer payment: **Payments** (the Checkout charge; the transfer is linked from it).
- Seller transfer: **Connect → Connected accounts → (seller) → Activity / Balances**, or **Balances → Transfers** on the platform.
- The money stays in the connected account's **test balance**. Nothing is paid out to a bank.

## Troubleshooting

- **"Stripe not configured (set STRIPE_SECRET_KEY)"** on the dashboard: the key is missing, blank or not a test-mode key. Restart `npm run dev` after editing `.env.local`.
- **Paid on Stripe but the order stays `pending`:** click **Check payment status** in the Negotiation panel (or `curl -X POST localhost:3000/api/orders/ORD{n}/confirm`). If you use the optional webhook: check that `stripe listen` is running and `STRIPE_WEBHOOK_SECRET` matches the secret it printed. The CLI output shows the HTTP status for each forwarded event (`400` = signature mismatch, `503` = secret missing).
- **Amounts under $0.50:** Stripe rejects Checkout totals below its minimum charge amount, so checkout fails for very small offers.
- **Switched `STRIPE_SECRET_KEY` to another Stripe account or sandbox:** orders paid under the old account keep their old Checkout session ids, which the new account cannot see. Confirming them returns `404 SESSION_NOT_FOUND`, and their seller payout is recorded as `failed` ("Checkout session not found in this Stripe account …") instead of erroring. Start a new order to test the new account. Connected account ids stored on users belong to the old account too. If a transfer then fails with "No such destination", clear `users.stripe_account_id` for that seller (or delete `./.pglite`) and retry.
- **"Seller payout: enable Stripe Connect":** finish "Enable Connect in the sandbox" above, then click **Check payment status** or **Retry payout**, or call `POST /api/orders/{id}/payout`.
- **`npm run stripe:sellers` says the database is in use:** the embedded PGlite database (`./.pglite`) can only be opened by one process. Stop `npm run dev`, or use `curl -X POST localhost:3000/api/stripe/sellers` against the running server.

