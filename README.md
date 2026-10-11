# PingMarket

SMS-first marketplace aggregation network. Buyers text (or use the demo dashboard) to find native listings across marketplaces plus external agent capabilities discovered via **Darwin Search**; sellers list and negotiate over **Dial** SMS.

See [PingMarket_PRD_v1.md](./PingMarket_PRD_v1.md) for the full product spec, work split, and demo script.

## Quick start

```bash
npm install
cp .env.example .env.local   # optional; everything has a working default
npm run dev                  # http://localhost:3000 → /dashboard
```

With no `DATABASE_URL`, the app uses an embedded Postgres ([PGlite](https://pglite.dev)) stored in `./.pglite`. It is migrated and seeded automatically on first request (2 marketplaces, 4 demo users, listings `D1`–`D8`). Delete `./.pglite` to reset.

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
| `npm run db:generate` | Regenerate SQL migrations from `src/lib/db/schema.ts` |
| `npm run db:migrate` / `db:seed` | Apply migrations / seed an external Postgres |

## Layout (Developer B modules)

```
src/lib/types.ts            FROZEN shared types (Listing, Offer, SearchRequest/Response, DarwinCapabilityResult)
src/lib/contracts.ts        zod schemas for request bodies
src/lib/db/                 drizzle schema, dual-driver getDb() (PGlite | postgres-js), seed, id minting
src/lib/listings/service.ts createListing / listListings / getListing / updateListingStatus
src/lib/offers/service.ts   createOffer / listOffers / getOffer (+ OfferError)
src/lib/darwin/             Darwin Search v3 client, normalization, runDarwinDiscovery()
src/lib/search/             parseBuyerQuery, searchNative, merge/rank, runSearch orchestrator
src/lib/events/             trace-event feed for the dashboard
src/app/api/                search, listings, offers (create/list), marketplaces, events
src/app/dashboard/          buyer demo dashboard (client-side, polls the API)
drizzle/                    generated SQL migrations
```

## Integration points for Developer A (Dial / SMS / negotiation)

- **Create a listing from `SELL`:** call `createListing({ sellerId, marketplaceId, title, priceCents, location, description })` from `src/lib/listings/service.ts`. Ids are minted as `D{n}` (seeded `D1`–`D8`, minted ids start at `D101` and are not contiguous).
- **Search from `SEARCH`:** call `runSearch(req)` from `src/lib/search/service.ts` (native + Darwin) or `searchNative(req)` for SMS-only replies. Both return the frozen `SearchResponse` / `NativeListingResult[]` shapes.
- **Create an offer from `OFFER D42 100`:** call `createOffer({ listingId, priceCents, buyerId: <mapped SMS user id>, source: "sms" })`. Dedupe webhook retries on `messages.dial_event_id` (unique) before calling it. `OfferError.code` tells you why it was rejected.
- **Negotiation transitions** (`counter` / `accept` / `decline`, `src/lib/negotiation/service.ts`, `/api/offers/{id}/{counter|accept|decline}`) are **yours**. The dashboard already calls `POST /api/offers/{id}/accept` for the buyer-accepts-counter step and shows the countered price from `offers.proposed_price_cents` / `status = "countered"`. Reuse `toOffer(row)` from the offers service for responses.
- **SMS trace:** insert into `messages` (`id`, `dial_event_id`, `from_number`, `to_number`, `body`, `direction`). The dashboard event feed reads this table and masks numbers to the last 4 digits.
- Seeded users: `u_seller_demo` (phone = `DIAL_NUMBER_B`), `u_seller_2`, `u_web_buyer` (dashboard's simulated buyer), `u_operator`.

## Darwin Search notes

- Endpoint `POST https://api.darwin.so/api/v3/search`, anonymous allowed; set `DARWIN_API_KEY` for the authenticated limit.
- Results are **capabilities, not inventory or quotes**. The API and dashboard keep them in a separate `externalCapabilities` list and surface `needs_input` questions, `no_match` reasons, readiness, uncertainties and connection methods verbatim. Ids and revisions are copied exactly; the private `searchToken` is never persisted or returned.
- A transient HTTP 500 from Darwin was observed once during development; the client retries 5xx once.
