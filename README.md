# PingMarket

PingMarket is an SMS-first marketplace that connects buyers, sellers, and external shopping agents in one flow. Buyers find items across marketplaces, negotiate prices, and complete checkout. Sellers publish listings, respond to offers, and receive sale notifications. The dashboard brings listings, conversations, orders, and activity together.

## How it works

1. **Find an item.** Search by item, budget, and location from the dashboard or by text. PingMarket combines marketplace listings with external agent discovery through Darwin Search.
2. **Get the details.** Open a listing or request an agent's details, refine your search, and contact discovered agents through Darwin Act.
3. **Agree on a price.** Send an offer, counter, accept, or decline. Accepted offers reserve the listing and create an order at the agreed price.
4. **Complete checkout.** Buy an available item at its asking price or pay for an accepted offer through hosted Stripe Checkout.
5. **Track the sale.** PingMarket verifies payment with Stripe, marks the order paid and the listing sold, and sends purchase notifications. Stripe Connect handles seller transfers.

## Connected integrations

| Integration | What it powers |
|---|---|
| **Dial** | Inbound SMS, command replies, and buyer offer updates |
| **Darwin Search** | External agent discovery, search refinement, and related searches |
| **Darwin Act** | Conversations with agents discovered in search |
| **Stripe Checkout** | Hosted payment pages and server-verified payment confirmation |
| **Stripe Connect** | Seller accounts and order-linked transfers |
| **Keewano** | Marketplace activity analytics and demand-aware negotiation insights |
| **Postgres / PGlite** | Listings, users, offers, orders, messages, and search history |

The SMS and web interfaces share marketplace services, keeping inventory, negotiation, and order status connected across channels.

## Quick start

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open [localhost:3000](http://localhost:3000) to go straight to the simulated buyer and seller phones at `/sim`. The [live view](http://localhost:3000/live) shows the real Dial conversation, SMS seller negotiation, and Keewano project analytics. The [operator dashboard](http://localhost:3000/dashboard) remains available.

`/live` reads real messages from the configured Dial buyer/service pair and excludes simulator and local inbound-test messages. It polls messages every 4 seconds and Keewano every 30 seconds. Dial must forward its signed webhook to this app's `/api/dial/webhook`; the live view does not register a webhook or send a test SMS. Keewano credentials enable the live analytics automatically after a server restart. Analytics cover the whole Keewano project, including simulator activity and synthetic backfills.

Add your integration credentials to `.env.local` using the settings below. Keep credentials server-side and out of version control.

### Database

PingMarket uses embedded Postgres through PGlite when `DATABASE_URL` is unset. Data is persisted in `./.pglite`, and migrations and initial listings are loaded automatically on the first request.

For a shared Postgres or Supabase database, set `DATABASE_URL` in `.env.local`, then run:

```bash
npm run db:migrate
npm run db:seed
```

Use `DATABASE_URL` for serverless deployments. Embedded storage requires a writable working directory and the `drizzle/` directory at runtime.

### Integration configuration

| Settings | Purpose |
|---|---|
| `DIAL_API_KEY`, `DIAL_SERVICE_NUMBER`, `DIAL_SERVICE_NUMBER_ID` | Connect the PingMarket SMS service number |
| `DIAL_PARTICIPANT_NUMBER` | Register the SMS buyer's phone number |
| `DIAL_WEBHOOK_SECRET`, `DIAL_SEND_ENABLED=true` | Verify inbound events and enable outgoing SMS |
| `DARWIN_API_KEY` | Authenticate Darwin Search and enable Act with Search + Act scopes |
| `STRIPE_SECRET_KEY` | Connect hosted Checkout and payment verification; supported key configuration is documented in the Stripe setup guide |
| `APP_URL` | Set the public origin for checkout return URLs and SMS payment links; required in production |
| `STRIPE_WEBHOOK_SECRET` | Verify Stripe webhook events |
| `PLATFORM_FEE_BPS` | Set the platform's share of the settled net amount for seller transfers |
| `KEEWANO_API_KEY` | Send marketplace activity to Keewano |
| `KEEWANO_PAT`, `KEEWANO_USER_EMAIL`, `KEEWANO_PROJECT_ID` | Connect live analytics queries for negotiation insights |

Detailed setup guides: [Dial](./docs/DIAL_SETUP.md), [Stripe](./docs/STRIPE_SETUP.md), and [Keewano](./docs/KEEWANO_SETUP.md).

## Marketplace dashboard

The dashboard connects the buyer journey and seller workflow:

- Search marketplace listings and discover external agents.
- Refine Darwin searches and send messages to discovered agents.
- Review listings, submit offers, and manage counters, accepts, and declines.
- Open Stripe Checkout for orders and confirm payment status.
- Track seller transfers and view negotiation insights.
- Follow marketplace activity through the event feed.

## Buyer and seller phone interface

The phone interface at `/sim` connects buyer and seller conversations to the same listings, search, negotiation, and payment services used by the dashboard and SMS gateway.

Sellers publish listings and respond to offers. Buyers search, request details, negotiate, and use **Buy** to open Stripe Checkout. Buying an available item reserves it at the asking price; buying through an accepted offer preserves the agreed price. Repeated checkout requests reuse the order and open session.

After checkout, the server retrieves payment status from Stripe before recording the sale. The seller receives a **Sold!** message, and the buyer receives a receipt. **Check payment** confirms the order when the return from Checkout is interrupted. Canceled checkout retains the buyer's reservation so payment can resume.

## SMS commands

The registered buyer texts `DIAL_SERVICE_NUMBER` from `DIAL_PARTICIPANT_NUMBER`.

| Command | Result |
|---|---|
| `SEARCH office chair under $100` | Find marketplace listings and external agents |
| `DETAILS D2` | Get listing details |
| `OFFER D2 80` | Offer $80 for listing D2 |
| `ACCEPT O7` | Accept a seller counter, reserve the listing, and receive order details and a checkout link |
| `DECLINE O7` | Decline a seller counter |
| `AGENT 1` | Get details for an agent from the latest search |
| `HELP` | View available commands |
| `STOP` | Stop offer-update messages |

Seller channels also support `SELL`, `COUNTER`, `ACCEPT`, and `DECLINE`. The registered Dial participant is assigned the buyer role. Changing `DIAL_PARTICIPANT_NUMBER` updates that buyer's identity on the next restart.

Dial sends inbound events to `/api/dial/webhook`. PingMarket verifies signatures, stores messages, deduplicates event retries, and processes messages from each phone in arrival order. Seller responses trigger buyer updates through Dial.

## Payments and order tracking

Stripe Checkout collects payment details on Stripe's hosted page. PingMarket confirms the Checkout Session with Stripe on return, on demand, or through a signed webhook. It checks the order, amount, currency, and payment status before marking an order paid and its listing sold in one transaction.

Order creation, payment confirmation, and seller transfers use idempotent operations. A checkout link or return URL alone does not record a payment. Seller transfers are linked to the order's charge and account for Stripe fees and the configured platform fee.

See the [Stripe setup guide](./docs/STRIPE_SETUP.md) for account configuration, supported credentials, webhook forwarding, and seller provisioning.

## Development commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the development server |
| `npm run build` / `npm run start` | Build and run the Next.js application |
| `npm test` | Run the Vitest suite |
| `npm run test:messaging` | Run messaging tests |
| `npm run typecheck` / `npm run lint` | Check TypeScript and ESLint |
| `npm run db:generate` | Generate SQL migrations from the Drizzle schema |
| `npm run db:migrate` / `npm run db:seed` | Apply migrations and load initial data |
| `npm run dial:doctor` / `npm run dial:numbers` | Check Dial connectivity and phone configuration |
| `npm run darwin:probe -- "query"` | Query Darwin Search and inspect normalized results |
| `npm run darwin:acceptance` | Run Darwin integration checks against a running app |
| `npm run stripe:listen` | Forward Stripe webhooks to the local app using the Stripe CLI |
| `npm run stripe:sellers` | Provision seller Connect accounts |
| `npm run keewano:check` | Check Keewano ingestion and live queries |
| `npm run keewano:backfill` | Populate negotiation analytics history |

## Project structure

```text
src/app/dashboard/        Marketplace dashboard
src/app/sim/              Buyer and seller phone interface
src/app/api/              Marketplace, messaging, agent, and payment endpoints
src/components/           Dashboard and phone interface components
src/lib/db/               Drizzle schema, database drivers, migrations, and seed data
src/lib/listings/         Listing creation and inventory status
src/lib/search/           Query parsing, native search, and result ranking
src/lib/darwin/           Darwin Search and Act clients
src/lib/offers/            Offer creation and transitions
src/lib/negotiation/       Counter, accept, and decline workflows
src/lib/orders/            Order creation and payment state
src/lib/payments/          Stripe Checkout, confirmation, and seller transfers
src/lib/sms/               Shared SMS command routing, inbox, replies, and notifications
src/lib/dial/              Dial connectivity and webhook verification
src/lib/keewano/           Activity ingestion and negotiation insights
src/lib/events/            Dashboard activity feed
scripts/                  Database and integration utilities
drizzle/                  SQL migrations
```

Built with Next.js, React, TypeScript, Tailwind CSS, Drizzle ORM, and Postgres.

See [PingMarket_PRD_v1.md](./PingMarket_PRD_v1.md) for the product specification and [sparta/README.md](./sparta/README.md) for agent evaluation tooling.

## Sparta sample test results

The saved [Sparta evidence](./sparta/evidence/submission.json) records **9 of 9 passing runs**: three SMS shopping missions, each repeated three times with the `interruption` scenario enabled. These are recorded results, not a fresh run performed for this README update.

| Buyer request | Recorded outcome per run | Result |
|---|---|---|
| "looking for a desk under $150 in Berkeley" | One invoice item and one unpaid draft invoice, totaling $120 | 3/3 passed |
| "need an office chair and a floor lamp, max $150" | Two invoice items collected in one unpaid draft invoice, totaling $140 | 3/3 passed |
| "standing desk under $100" | No invoice items or invoices created; no cheaper product substituted | 3/3 passed |

In every recorded run, Sparta injected an HTTP 500 on `GET /v1/products`; the agent retried successfully. The resulting state contained no duplicate invoice items, and all declared checks passed, including no charge or payment-intent attempts, no new products or prices, and an unchanged buyer record.

This evaluates the separate scripted shopping agent against Sparta's local Stripe twin. It shares PingMarket's query parser but does not exercise live SMS delivery, hosted Checkout, or seller payouts. See the [Sparta guide](./sparta/README.md) for the test inputs and reproduction commands.
