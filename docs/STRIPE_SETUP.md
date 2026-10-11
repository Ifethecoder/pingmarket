# Stripe test-mode checkout (PM-11)

PingMarket takes one agreed price through a **hosted Stripe Checkout page in test mode**. The order turns `paid` only when a **signed Stripe webhook** says so. Generating the link, opening it, or landing back on `/dashboard?checkout=success` never marks anything paid. No Stripe Connect, no payouts, no real money.

## 1. Secret key

1. Open the [Stripe Dashboard](https://dashboard.stripe.com) and turn on **Test mode** (toggle at the top right; newer dashboards may show a **Sandbox** switcher instead).
2. Go to **Developers → API keys** and copy the **Secret key** (`sk_test_…`). A restricted test key (`rk_test_…`) with write access to Checkout Sessions also works.
3. Put it in `.env.local`:

   ```bash
   STRIPE_SECRET_KEY=sk_test_...
   ```

Live keys (`sk_live_…`) are refused: the app reports `STRIPE_NOT_CONFIGURED`. Never commit `.env.local`, and never paste keys into issues, chat or logs.

## 2. Webhook secret

The webhook endpoint is `POST /api/stripe/webhook`. Without `STRIPE_WEBHOOK_SECRET` it answers `503`, and orders stay `pending`.

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
6. Set `APP_URL=https://<your-host>` in the deployment's environment. It is server-only and read at runtime. In production, checkout refuses to start without it (`503 APP_URL_REQUIRED`), so a forged `Host` header can never choose where Stripe redirects the buyer. In development the request origin is used when it is unset.

## 3. Demo flow

1. `npm run dev`, then `npm run stripe:listen` in another terminal (with `STRIPE_WEBHOOK_SECRET` set as above).
2. On `/dashboard`, send an offer on a native listing and get it to `accepted` (via Developer A's negotiation flow, or by accepting a seller counter on the dashboard).
3. In the **Negotiation** panel the accepted offer shows **Pay with Stripe (test)**. Clicking it:
   - `POST /api/orders { offerId }` gets or creates the order (`ORD{n}`, `pending`, amount = accepted price);
   - `POST /api/orders/{id}/checkout` creates (or reuses, while still open) a hosted Checkout Session;
   - the browser goes to Stripe's hosted page.
4. Pay with the test card **4242 4242 4242 4242**, any future expiry date, any CVC and any postal code.
5. Stripe redirects to `/dashboard?checkout=success&order=ORD{n}`. The dashboard shows "Returned from Stripe — waiting for webhook confirmation" and removes the query string. The order is still `pending` at this point.
6. Stripe sends `checkout.session.completed` with `payment_status = "paid"` through `stripe listen`. The webhook checks the signature, marks the order `paid` and the listing `sold` in one transaction, and the panel shows a **Paid** chip within about 4 seconds. The event trace shows `Order ORD{n} paid via Stripe test checkout`.

Cancelling on the Stripe page returns to `?checkout=cancel`; the order stays `pending` and the button can be used again (the still-open session is reused).

If the buyer paid but the webhook has not arrived yet, clicking the button again does **not** create a second session: the API answers `409 PAYMENT_PROCESSING` and the panel shows "Payment received, awaiting confirmation…". A `failed` order shows **Retry payment**, which starts a fresh session and moves the order back to `pending`.

## Behaviour reference

| Event | Effect |
|---|---|
| `checkout.session.completed`, `payment_status = "paid"` | `pending → paid`, listing → `sold` |
| `checkout.session.completed`, `payment_status = "unpaid"` (async method) | stays `pending` until the async result arrives |
| `checkout.session.async_payment_succeeded` | `pending → paid`, listing → `sold` |
| `checkout.session.async_payment_failed` | `pending → failed` |
| `checkout.session.expired` | stays `pending`; the next click creates a new session |
| any other event | `200 { received: true, ignored: true }` |

- The order id is read from `client_reference_id`, falling back to `metadata.orderId`.
- A paid event must match the order's amount and be in `usd`; otherwise it is logged and ignored (`reason: "amount_mismatch"`). Live-mode events are ignored (`reason: "livemode"`).
- A signed paid event is authoritative: it pays a `pending` or `failed` order even if a newer session was created since, and records the paid session id. A second, different paid session for an already-paid order is logged as a conflict (possible double payment, refund it in the Stripe Dashboard) and ignored.
- Duplicate deliveries are no-ops (`changed: false`). Events that can never apply (unknown order, amount mismatch, second payment) get a `200` acknowledgement so Stripe stops retrying; database errors return `500` so Stripe retries.
- Bad or missing signatures get `400`. The raw body and card data are never logged; card details only ever exist on Stripe's hosted page.

## Troubleshooting

- **"Stripe not configured (set STRIPE_SECRET_KEY)"** on the dashboard: the key is missing, blank or not a test-mode key. Restart `npm run dev` after editing `.env.local`.
- **Paid on Stripe but the order stays `pending`:** `stripe listen` is not running, `STRIPE_WEBHOOK_SECRET` does not match the secret it printed, or the dev server was not restarted. The CLI output shows the HTTP status for each forwarded event (`400` = signature mismatch, `503` = secret missing).
- **Amounts under $0.50:** Stripe rejects Checkout totals below its minimum charge amount, so checkout fails for very small offers.
