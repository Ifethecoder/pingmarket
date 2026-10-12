# Keewano: demand-aware negotiation

PingMarket sends every negotiation step to [Keewano](https://docs.keewano.com/getting-started/speedhacks-quickstart). Before a seller answers an offer, PingMarket queries Keewano live and recommends **ACCEPT** or **COUNTER at $X**:

```
offer created / countered / accepted / declined / paid ──► Keewano (REST ingest, fire-and-forget)
                                                              │
seller gets "New offer O7…" SMS  ◄── insight ◄── live SQL ────┘
dashboard seller console          (pgsql.keewano.com)
```

The insight runs three queries (`src/lib/keewano/insight.ts`):

1. **Live demand:** other offers on this listing in the last 24h, and the highest one.
2. **Attention:** `DETAILS` views of this listing in the last 24h.
3. **What buyers accept:** for this marketplace, buyer accept and decline counts after a seller counter, grouped by the counter's share of the ask (`80-89`, `90-99`, `100+`).

`adviseNegotiation` turns the answers into a recommendation:

- Target the highest counter band that buyers accepted at least half the time, with 3 or more samples behind it.
- Raise the target 5 points when the listing has 2 or more competing offers.
- Never go below the best rival offer, and never go above the ask.
- If the offer already meets the target, recommend accepting it.

Without Keewano, the seller sees no tip at all.

Each recommendation is written back as `Negotiation Advice` and `Advice Price Cents` on the offer's timeline. Keewano can then compare advice that was followed with deals that closed.

## Setup (about 5 minutes)

1. Sign up at <https://www.keewano.com/> and create a project. In the platform chat (bottom left), send `#SpeedHacks`.
2. Fill these in `.env.local`:

   | Variable | Where to find it |
   |---|---|
   | `KEEWANO_API_KEY` | Settings → Project → API Keys (SDK key, used for sending events) |
   | `KEEWANO_PAT` | Settings → Personal → Security (`kwpat-…`, used for live SQL) |
   | `KEEWANO_USER_EMAIL` | The email you signed up with |
   | `KEEWANO_PROJECT_ID` | Settings → Details → Project ID (a UUID) |

3. Seed history so the advice has data from the first minute. This is synthetic, tagged `Offer Source = backfill`, and older than 24h:

   ```bash
   npm run keewano:backfill          # 240 offers over 14 days; --offers N --days N
   ```

4. Wait about 5 minutes for ingestion, then check both connections:

   ```bash
   npm run keewano:check
   ```

5. Restart `npm run dev`. Open offers in the dashboard's Negotiation panel now show a **Keewano** box with the recommendation and a **Use $X** button. The `/sim` seller phone's new-offer text ends with a tip such as `Tip: buyers accepted 5/8 counters at 90-99% of ask. Try COUNTER O7 190.`

To let an agent answer unprepared questions from the same data, connect Claude Code over MCP:

```bash
claude mcp add --scope user --transport http keewano https://api.keewano.com/mcp --header "k-token: $KEEWANO_PAT"
```

## Events

Event ids are 2000 and up. The catalog lives in `src/lib/keewano/catalog.ts` and is append-only. Each entity is a UUID v5 built from `pingmarket:<kind>:<id>:<created-at-seconds>`, so deleting `.pglite` never merges a new `O1` into an old one.

| Entity | Events |
|---|---|
| offer | `Offer Key`, `Offer Listing`, `Offer Listing Key`, `Offer Marketplace`, `Offer Source`, `Offer Ask Cents`, `Offer Pct Of Ask`, `Offer Band`, `Offer Made Cents`, then `Counter Band` + `Counter Cents`, `Offer Accepted(seller\|buyer)`, `Offer Declined(seller\|buyer)`, `Offer Superseded`, `Order Paid Cents`, `Negotiation Advice` + `Advice Price Cents` |
| listing | `Listing Key`, `Listing Marketplace`, `Listing Ask Cents`, `Listing Viewed(sms\|sim)` |
| search | `Search Marketplace`, `Search Darwin Status`, `Search External Results`, `Search Native Results` |

Money is sent as `uint` cents in the listing's currency.

Sending is skipped when `KEEWANO_API_KEY` is unset and always under Vitest. Live queries time out after `KEEWANO_QUERY_TIMEOUT_MS` (default 4000). In both cases the marketplace keeps working and the tip is omitted.
