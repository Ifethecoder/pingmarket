# PingMarket

SMS-first marketplace aggregation network. Buyers text (or use the demo dashboard) to find native listings across marketplaces plus external agent capabilities discovered via **Darwin Search**; sellers list and negotiate over **Dial** SMS.

See [PingMarket_PRD_v1.md](./PingMarket_PRD_v1.md) for the full product spec, work split, and demo script.

## Quick start

```bash
npm install
cp .env.example .env.local   # optional; everything has a working default
npm run dev                  # http://localhost:3000 → /dashboard
```

`DIAL_PARTICIPANT_NUMBER` (Dial Number B, see `docs/DIAL_SETUP.md`; legacy `DIAL_NUMBER_B` still honored) if set becomes the phone number of the seeded demo seller `u_seller_demo`; set it before the first seed (or reset the DB) for it to take effect. `npm run db:migrate` / `db:seed` read `.env.local` and `.env` automatically.

With no `DATABASE_URL`, the app uses an embedded Postgres ([PGlite](https://pglite.dev)) stored in `./.pglite`. It is migrated and seeded automatically on first request (2 marketplaces, 4 demo users, listings `D1`–`D8`). Delete `./.pglite` to reset. Embedded PGlite mode needs a writable working directory and the `drizzle/` folder at runtime, so it is for local/demo use; set `DATABASE_URL` for serverless/production deploys.

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
src/lib/sms/simulator.ts    simulated handsets: parseSms → listings/search/offers, replies stored in `messages` (sim_ ids)
src/app/api/                search, listings, offers (create/list), orders, stripe/webhook, marketplaces, events, sms/simulate
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

- seller phone → seeded `u_seller_2` (owns `D2`, `D4`, `D6`, `D8`). The real Dial seller `u_seller_demo` is untouched.
- buyer phone → seeded `u_web_buyer`; offers keep `source: "web_simulated"`.

`ACCEPT` / `COUNTER` / `DECLINE` reply "not wired yet" until Developer A's negotiation service is passed as the
`negotiation` port of `simulateSms` (see `NegotiationPort`). Listing drafts awaiting a price/location are kept in
memory for 10 minutes; this is a demo simulator, not the durable inbox the webhook needs.

## Integration points for Developer A (Dial / SMS / negotiation)

- **Create a listing from `SELL`:** call `createListing({ sellerId, marketplaceId, title, priceCents, location, description })` from `src/lib/listings/service.ts`. Ids are minted as `D{n}` (seeded `D1`–`D8`, minted ids start at `D101` and are not contiguous).
- **Search from `SEARCH`:** call `runSearch(req)` from `src/lib/search/service.ts` (native + Darwin) or `searchNative(req)` for SMS-only replies. Both return the frozen `SearchResponse` / `NativeListingResult[]` shapes.
- **Create an offer from `OFFER D42 100`:** call `createOffer({ listingId, priceCents, buyerId: <mapped SMS user id>, source: "sms" })`. Dedupe webhook retries on `messages.dial_event_id` (unique) before calling it. `OfferError.code` tells you why it was rejected.
- **Negotiation transitions** (`counter` / `accept` / `decline`, `src/lib/negotiation/service.ts`, `/api/offers/{id}/{counter|accept|decline}`) are **yours**. The dashboard already calls `POST /api/offers/{id}/accept` for the buyer-accepts-counter step and shows the countered price from `offers.proposed_price_cents` / `status = "countered"`. Reuse `toOffer(row)` from the offers service for responses.
- **Orders:** when a buyer accepts, call `getOrCreateOrderForOffer(offerId)` from `src/lib/orders/service.ts` (idempotent; `orders.offer_id` is unique). The dashboard's "Pay with Stripe (test)" button calls the same function, so either side may create the order first.
- **SMS trace:** insert into `messages` (`id`, `dial_event_id`, `from_number`, `to_number`, `body`, `direction`). The dashboard event feed reads this table and masks numbers to the last 4 digits.
- Seeded users: `u_seller_demo` (phone = `DIAL_PARTICIPANT_NUMBER`), `u_seller_2`, `u_web_buyer` (dashboard's simulated buyer), `u_operator`.

## Stripe test checkout (PM-11)

One pending order → hosted Stripe **test-mode** Checkout → signed webhook → `paid`. Setup and demo steps: [docs/STRIPE_SETUP.md](./docs/STRIPE_SETUP.md).

- Env: `STRIPE_SECRET_KEY` (`sk_test_…` only; live keys are refused), `STRIPE_WEBHOOK_SECRET` (`whsec_…`), `APP_URL` for the return URLs (optional in dev, required in production).
- API: `GET /api/orders` → `{ orders }`; `POST /api/orders { offerId }` → `{ order }` (201 created / 200 existing, accepted offers only); `POST /api/orders/{id}/checkout` → `{ url, sessionId }` (503 `STRIPE_NOT_CONFIGURED` / `APP_URL_REQUIRED`; 409 `ORDER_NOT_PENDING`, `PAYMENT_PROCESSING`, `LISTING_UNAVAILABLE`; 400 `STRIPE_INVALID_REQUEST`; 502 `STRIPE_ERROR`); `POST /api/stripe/webhook`.
- **Only the signed webhook marks an order `paid`** (`checkout.session.completed` / `async_payment_succeeded` with `payment_status = "paid"`, matching amount and `usd`, test mode), and it also marks the listing `sold`. Creating the link or landing on `?checkout=success` never does. Duplicate deliveries are no-ops. A `failed` order can be retried from the dashboard.
- Card details stay on Stripe's hosted page. No Connect, no payouts.

## Darwin Search notes

- Endpoint `POST https://api.darwin.so/api/v3/search`, anonymous allowed; set `DARWIN_API_KEY` for the authenticated limit.
- Results are **capabilities, not inventory or quotes**. The API and dashboard keep them in a separate `externalCapabilities` list and surface `needs_input` questions, `no_match` reasons, readiness, uncertainties and connection methods verbatim. Ids and revisions are copied exactly; the private `searchToken` is never persisted or returned.
- A transient HTTP 500 from Darwin was observed once during development; the client retries 5xx once.
- **Follow-ups.** Send `previousResponseId` (the `darwin.responseId` from an earlier `/api/search` response) with a new `query` to continue that Darwin search: answer a `needs_input` question or refine the match. The dashboard shows a follow-up box under the external results, plus Darwin's `relatedSearches` as one-click suggestions. Darwin treats the follow-up text as the *new* task ("latest task wins"), so restate the full request, e.g. `compare prices for a Herman Miller Aeron under $800`, not just `Aeron`. Mechanics: the first response's private `searchToken` is stored in `agent_searches.darwin_search_token` and sent back as `X-Search-Token` (required for anonymous follow-ups; follow-up responses don't issue a new one, so it is carried forward). An unknown `previousResponseId` is a 400 (`UNKNOWN_PREVIOUS_RESPONSE`); a continuation Darwin no longer accepts (400 `SEARCH_RESPONSE_EXPIRED` / 403 `SEARCH_TOKEN_REQUIRED`) becomes `darwin.status: "error"` with a "start a new search" message.
