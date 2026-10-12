# PingMarket

SMS-first marketplace aggregation network. Buyers text (or use the demo dashboard) to find native listings across marketplaces plus external agent capabilities discovered via **Darwin Search**; sellers list and negotiate over **Dial** SMS.

See [PingMarket_PRD_v1.md](./PingMarket_PRD_v1.md) for the full product spec, work split, and demo script.

## Quick start

```bash
npm install
cp .env.example .env.local   # optional; everything has a working default
npm run dev                  # http://localhost:3000 → /dashboard
```

`DIAL_PARTICIPANT_NUMBER` (Dial Number B, see `docs/DIAL_SETUP.md`; legacy `DIAL_NUMBER_B` still honored) is the real **buyer** phone: it becomes the phone of the seeded SMS buyer `u_sms_buyer` (default `+15550000011`). The seed runs on every boot and reconciles existing databases (an older seed gave this number to the seller `u_seller_demo`, which now always has the fake `+15550000002`), so changing the variable takes effect on the next restart. `npm run db:migrate` / `db:seed` read `.env.local` and `.env` automatically.

With no `DATABASE_URL`, the app uses an embedded Postgres ([PGlite](https://pglite.dev)) stored in `./.pglite`. It is migrated and seeded automatically on first request (2 marketplaces, 5 demo users, listings `D1`–`D8`). Delete `./.pglite` to reset. Embedded PGlite mode needs a writable working directory and the `drizzle/` folder at runtime, so it is for local/demo use; set `DATABASE_URL` for serverless/production deploys.

To use Supabase/Postgres instead:

```bash
export DATABASE_URL=postgres://...
npm run db:migrate && npm run db:seed
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js app |
| `npm test` | Vitest suite (DB in-memory PGlite, Darwin adapter with recorded fixtures, search ranking) |
| `npm run typecheck` / `npm run lint` | TypeScript / ESLint |
| `npm run darwin:probe -- "query"` | Live Darwin Search call, prints normalized capabilities |
| `npm run darwin:acceptance` | Live end-to-end Darwin checks against a running `npm run dev` (PM-06/PM-07, Journey B, follow-ups) |
| `npm run db:generate` | Regenerate SQL migrations from `src/lib/db/schema.ts` |
| `npm run db:migrate` / `db:seed` | Apply migrations / seed an external Postgres |
| `npm run stripe:listen` | Forward Stripe test webhooks to `localhost:3000/api/stripe/webhook` (needs the Stripe CLI) |
| `npm run stripe:sellers` | Create/reuse Stripe Connect test accounts for sellers (`-- --payout-pending` also retries seller payouts); stop `npm run dev` first or use `POST /api/stripe/sellers` |
| `npm run sparta:open` / `sparta:run` / `sparta:evidence` | Test the SMS checkout agent against a [Sparta Worlds](https://www.usesparta.co) Stripe twin (Node 24+); see [sparta/README.md](./sparta/README.md) |

## Layout (Developer B modules)

```
src/lib/types.ts            FROZEN shared types (Listing, Offer, SearchRequest/Response, DarwinCapabilityResult)
src/lib/contracts.ts        zod schemas for request bodies
src/lib/db/                 drizzle schema, dual-driver getDb() (PGlite | postgres-js), seed, id minting
src/lib/listings/service.ts createListing / listListings / getListing / updateListingStatus
src/lib/offers/service.ts   createOffer / listOffers / getOffer (+ OfferError)
src/lib/orders/service.ts   getOrCreateOrderForOffer / listOrders / markOrderPaid (+ OrderError)
src/lib/payments/stripe.ts  Stripe test-mode Checkout + webhook signature verification (only Stripe code)
src/lib/darwin/             Darwin Search v3 client, normalization, runDarwinDiscovery()
src/lib/search/             parseBuyerQuery, searchNative, merge/rank, runSearch orchestrator
src/lib/events/             trace-event feed for the dashboard
src/lib/negotiation/db-service.ts  counter / accept / decline over drizzle (+ NegotiationError)
src/lib/sms/gateway.ts      shared SMS command router (parseSms → listings/search/offers/negotiation) for every phone
src/lib/sms/simulator.ts    /sim handsets: gateway + replies stored in `messages` (sim_ ids)
src/lib/sms/inbox.ts, inbound.ts, outbound.ts, notify.ts   real buyer over Dial: durable inbox, processing, sends, offer updates
src/lib/dial/runtime.ts     Dial env → { configured, sender } for the Next app
src/app/api/                search, listings, offers (create/list + {id}/counter|accept|decline), orders, stripe/webhook,
                            marketplaces, events, sms/simulate, dial/webhook, dial/simulate-inbound (dev only)
src/app/dashboard/          buyer demo dashboard (client-side, polls the API)
src/app/sim/                phone-style seller + buyer handsets (client-side, polls /api/sms/simulate)
drizzle/                    generated SQL migrations
```

## Simulated phones (`/sim`)

Two phone-style chat UIs, one seller and one buyer, that text PingMarket without Dial. Each text goes through
`parseSms` (the same grammar the webhook will use) and `src/lib/sms/simulator.ts` routes it into the real
listings / search / offers services. Replies and cross-handset notifications (an OFFER on the seller's listing
pings the seller phone) are stored in `messages` with `sim_…` Dial event ids, so the dashboard trace shows them
labelled `SIM`. Identity is fixed per handset and never inferred from the text:

- seller phone → seeded `u_seller_2` (owns `D2`, `D4`, `D6`, `D8`). The dashboard demo seller `u_seller_demo` is untouched.
- buyer phone → seeded `u_web_buyer`; offers keep `source: "web_simulated"`.

`ACCEPT` / `COUNTER` / `DECLINE` run the drizzle negotiation service (`src/lib/negotiation/db-service.ts`) by
default; pass another `NegotiationPort` as `negotiation` to substitute it. When the sim seller moves an offer made
by the real SMS buyer, that buyer is texted over Dial. The router itself (`src/lib/sms/gateway.ts`) is shared with
the real phone. Listing drafts awaiting a price/location are kept in memory for 10 minutes.

## Real SMS buyer over Dial

The real phone `DIAL_PARTICIPANT_NUMBER` is the buyer `u_sms_buyer`. It texts the PingMarket service number
`DIAL_SERVICE_NUMBER`; every inbound and outbound text is a `messages` row (trace label `SMS`, `detail.channel: "dial"`),
offers it makes have `source: "sms"`, and orders it accepts appear on the dashboard like any other.

What the phone can text:

| Text | Effect |
|---|---|
| `SEARCH office chair under $100` | Up to 3 native listings plus Darwin external agents (≤ 480 chars) |
| `DETAILS D2` | Listing details |
| `OFFER D2 80` | Opens an offer (`source: "sms"`); the seller answers on the dashboard |
| `ACCEPT O7` / `DECLINE O7` | Answer a seller counter. ACCEPT reserves the listing, declines competing offers and creates the order; the reply has the order id plus a Stripe test Checkout link when `STRIPE_SECRET_KEY` and `APP_URL` (or `NEXT_PUBLIC_APP_URL`) are set, else "Pay on the PingMarket dashboard." |
| `AGENT 1` | Details for an external agent from the last search |
| `HELP` / `STOP` | Commands / stop offer-update texts (texting again opts back in) |

`SELL` is refused: this number is registered as a buyer. Unknown numbers get "This number isn't registered with PingMarket."

Sellers act from the dashboard: `POST /api/offers/{id}/counter { priceCents }`, `/accept`, `/decline` (body `{}`) → `{ offer }`,
errors `{ error, code }` (`OFFER_NOT_FOUND` 404, `FORBIDDEN` 403, `INVALID_PRICE` 400, `OFFER_CLOSED` / `OFFER_EXPIRED` /
`LISTING_UNAVAILABLE` 409). These routes require `content-type: application/json` and, when an `Origin` header is sent,
a same-origin one (403 `FORBIDDEN` otherwise), so a cross-site form can't move offers. A repeated accept returns the
offer unchanged and texts nobody. The acting party is derived server-side: the seller on an `open` offer, the buyer on a
`countered` one. A countered `sms` offer can only be answered from the phone (409 `SMS_BUYER_ONLY`). After a seller
counters, accepts or declines an `sms` offer (or an accept declines a competing `sms` offer), the buyer is texted
(`Counter O7: $90.00 for D2 (…). Reply ACCEPT O7 or DECLINE O7.` / `Accepted O7 at $90.00 for D2. Order ORD3 is pending payment. …` / `Offer O7 on D2 was declined.`).

Wiring:

1. Fill the Dial block of `.env.local` (see `docs/DIAL_SETUP.md`) and `npm run dev`. `GET /api/dial/webhook` returns
   `{ configured, webhookReady, sendsEnabled }`. Replies are only sent with `DIAL_SEND_ENABLED=true`, and only ever to
   `DIAL_PARTICIPANT_NUMBER`; otherwise they are stored but not sent.
2. Expose the app: `cloudflared tunnel --url http://localhost:3000`.
3. Point the Dial `message.received` subscription at `https://<tunnel>/api/dial/webhook` and put its signing secret
   in `DIAL_WEBHOOK_SECRET`; restart `npm run dev`.

The webhook verifies the signature, stores the text (deduplicated on the Dial event id), answers 200 immediately and
routes/replies in `after()` (route `maxDuration` 60s), so a slow Darwin search never trips Dial's 10s timeout. Texts
from one phone are processed in arrival order (`SEARCH …` then `AGENT 1`).

Without Dial, exercise the same pipeline locally. `/api/dial/simulate-inbound` answers only direct local calls: 404 in
production, and 404 unless the `Host` is localhost / 127.0.0.1 / [::1], there is no `cf-connecting-ip` header, any
`x-forwarded-for` lists only loopback addresses (Next adds one itself for local calls; a tunnel sets the real client IP),
and the content-type is JSON, so it is unreachable through the tunnel. Its inbound rows have `dev_` event ids and
are labelled `SIM` in the trace; replies are still sent through Dial when it is configured and the recipient is the
participant number:

```bash
curl -s -X POST localhost:3000/api/dial/simulate-inbound -H 'content-type: application/json' \
  -d '{"from":"+15550000011","body":"SEARCH office chair"}'
```

Use the `DIAL_PARTICIPANT_NUMBER` value as `from` when it is set (the default buyer phone is `+15550000011`).

Known limitations:

- **Deduplication is per Dial event id only.** `messages` has no provider message-id column, so a second, different
  event carrying the same Dial message would be stored and processed again. Dial retries reuse the event id.
- **No processed marker.** An inbound row is processed once, in `after()`, with no `processed_at` column. If the process
  dies between storing the text and replying, the text is not retried; the buyer has to send it again.

## Integration points for Developer A (Dial / SMS / negotiation)

- **Create a listing from `SELL`:** call `createListing({ sellerId, marketplaceId, title, priceCents, location, description })` from `src/lib/listings/service.ts`. Ids are minted as `D{n}` (seeded `D1`–`D8`, minted ids start at `D101` and are not contiguous).
- **Search from `SEARCH`:** call `runSearch(req)` from `src/lib/search/service.ts` (native + Darwin) or `searchNative(req)` for SMS-only replies. Both return the frozen `SearchResponse` / `NativeListingResult[]` shapes.
- **Create an offer from `OFFER D42 100`:** call `createOffer({ listingId, priceCents, buyerId: <mapped SMS user id>, source: "sms" })`. Dedupe webhook retries on `messages.dial_event_id` (unique) before calling it. `OfferError.code` tells you why it was rejected.
- **Negotiation transitions** run on `src/lib/negotiation/db-service.ts` (same rules as `src/lib/negotiation/service.ts`, implemented with drizzle transactions) behind `/api/offers/{id}/{counter|accept|decline}` and the SMS `COUNTER` / `ACCEPT` / `DECLINE` commands.
- **Orders:** when a buyer accepts, call `getOrCreateOrderForOffer(offerId)` from `src/lib/orders/service.ts` (idempotent; `orders.offer_id` is unique). The dashboard's "Pay with Stripe (test)" button calls the same function, so either side may create the order first.
- **SMS trace:** insert into `messages` (`id`, `dial_event_id`, `from_number`, `to_number`, `body`, `direction`). The dashboard event feed reads this table and masks numbers to the last 4 digits.
- Seeded users: `u_sms_buyer` (phone = `DIAL_PARTICIPANT_NUMBER`, the real SMS buyer), `u_seller_demo` (`+15550000002`), `u_seller_2`, `u_web_buyer` (dashboard's simulated buyer), `u_operator`.

## Stripe test checkout (PM-11)

One pending order → hosted Stripe **test-mode (sandbox)** Checkout → server verifies the session with Stripe → `paid`. **Only `STRIPE_SECRET_KEY` is required**; the webhook is an optional backstop. Setup and demo steps: [docs/STRIPE_SETUP.md](./docs/STRIPE_SETUP.md).

- Env: `STRIPE_SECRET_KEY` (`sk_test_…` only; live keys are refused); `APP_URL` for the return URLs (optional in dev, required in production); optional `STRIPE_WEBHOOK_SECRET` (`whsec_…`, from `npm run stripe:listen`) for the webhook backstop.
- API: `GET /api/orders` → `{ orders }`; `POST /api/orders { offerId }` → `{ order }` (201 created / 200 existing, accepted offers only); `POST /api/orders/{id}/checkout` → `{ url, sessionId }` (503 `STRIPE_NOT_CONFIGURED` / `APP_URL_REQUIRED`; 409 `ORDER_NOT_PENDING`, `PAYMENT_PROCESSING`, `LISTING_UNAVAILABLE`; 400 `STRIPE_INVALID_REQUEST`; 502 `STRIPE_ERROR`); `POST /api/orders/{id}/confirm { sessionId? }` → `{ order, confirmed, sessionStatus, paymentStatus }`; optional `POST /api/stripe/webhook`.
- **An order is marked `paid` only after the server has a Checkout Session from Stripe itself** (retrieved with the secret key on return from Checkout / on demand, or in a signed webhook) that is test mode, for this order, `payment_status = "paid"`, with the order's amount in `usd`. The listing is marked `sold` in the same transaction. Creating the link or the `?checkout=success` URL alone never marks anything paid. Repeats are no-ops. A `failed` order can be retried from the dashboard.
- **Seller payouts (Stripe Connect, test mode):** every paid order also makes a Connect transfer, funded by the order's own charge (`source_transaction`, `transfer_group` = order id), to the seller's Custom test connected account. It is created automatically in the platform's country (US and JP test data). It is paid in the platform's settlement currency (e.g. JPY), minus `PLATFORM_FEE_BPS`. Retry with `POST /api/orders/{id}/payout`; provision accounts with `POST /api/stripe/sellers` or `npm run stripe:sellers`. Connect must be enabled in the sandbox; until then payouts show `not_configured` and the payment is unaffected. No bank payouts or live settlement.
- Card details stay on Stripe's hosted page.

## Darwin Search notes

- Endpoint `POST https://api.darwin.so/api/v3/search`, anonymous allowed; set `DARWIN_API_KEY` for the authenticated limit.
- Results are **capabilities, not inventory or quotes**. The API and dashboard keep them in a separate `externalCapabilities` list and surface `needs_input` questions, `no_match` reasons, readiness, uncertainties and connection methods verbatim. Ids and revisions are copied exactly; the private `searchToken` is never persisted or returned.
- A transient HTTP 500 from Darwin was observed once during development; the client retries 5xx once.
- **Follow-ups.** Send `previousResponseId` (the `darwin.responseId` from an earlier `/api/search` response) with a new `query` to continue that Darwin search: answer a `needs_input` question or refine the match. The dashboard shows a follow-up box under the external results, plus Darwin's `relatedSearches` as one-click suggestions. Darwin treats the follow-up text as the *new* task ("latest task wins"), so restate the full request, e.g. `compare prices for a Herman Miller Aeron under $800`, not just `Aeron`. Mechanics: the first response's private `searchToken` is stored in `agent_searches.darwin_search_token` and sent back as `X-Search-Token` (required for anonymous follow-ups; follow-up responses don't issue a new one, so it is carried forward). An unknown `previousResponseId` is a 400 (`UNKNOWN_PREVIOUS_RESPONSE`); a continuation Darwin no longer accepts (400 `SEARCH_RESPONSE_EXPIRED` / 403 `SEARCH_TOKEN_REQUIRED`) becomes `darwin.status: "error"` with a "start a new search" message.
