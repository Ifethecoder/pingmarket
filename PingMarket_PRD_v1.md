# PingMarket — Product Requirements Document

**Version:** 1.0  
**Date:** October 11, 2026  
**Project:** SpeedHacks MVP  
**Team:** 2 developers  
**Primary integrations:** Dial + Darwin  
**Supporting integrations (if time):** Stripe, Keewano, Sparta, Alike

## 1. Product summary

**PingMarket is an SMS-first marketplace aggregation network.** Buyers text what they want to find products, services, and seller agents across multiple marketplaces. Sellers can create listings, receive offers, and negotiate using text messages. Darwin expands the available supply beyond listings stored directly in PingMarket by discovering relevant AI agents and their capabilities. Dial provides the phone and messaging infrastructure.

**Core promise:** *Text what you need. Discover offers across marketplaces. Negotiate and transact without downloading another app.*

**Hackathon outcome:** Demonstrate that a seller can publish an item by SMS, that a buyer can search across native marketplace categories and discover external agent capabilities via Darwin, and that the parties can negotiate an agreed price. If time permits, complete a Stripe test-mode checkout.

## 2. Goals and non-goals

### P0: Must demonstrate
1. A real Dial SMS event is ingested and produces an application action.
2. A seller creates a native listing using one natural-language SMS, with a clarification if needed.
3. A buyer query searches **all opted-in native marketplace listings** and Darwin's public agent index.
4. Native listing matches are differentiated from Darwin agent capabilities; the latter are **not** represented as confirmed inventory or firm quotes.
5. A buyer submits an offer and the seller can accept or counter through a conversation managed by PingMarket.
6. A lightweight dashboard displays listings, messages, search results, negotiation states, and demo activity.

### P1: Add only after P0 is working
- Buyers opt in to alerts for saved interests; a new matching listing triggers an appropriate notification.
- Stripe Checkout in test mode after an agreed price; Mark `paid` only after the server verifies the Checkout Session with Stripe using the secret key (on return from Checkout, on demand, or via an optional signed webhook); never on link generation or the redirect URL alone.
- Keewano records structured events and a live query informs a user-facing decision.
- Sparta independently verifies a supported payment/refund-agent workflow.
- Alike preserves implementation decisions across coding-agent sessions, if access is granted.

### Out of scope for the hackathon
- A general-purpose vibe-code marketplace builder.
- Importing full product catalogs from third-party marketplaces without an authorized integration.
- Assuming all Darwin agents sell products, support negotiation, or have available inventory.
- Automated price bargaining without seller-approved limits.
- Live seller payouts and settlement, shipping/fulfillment, dispute arbitration, escrow, or production financial onboarding. (Test-mode Stripe Connect transfers to sellers are implemented: separate charges and transfers in the sandbox only.)
- Production SMS broadcasts to unregistered/opted-out personal numbers.

## 3. Users and marketplaces

**Buyer:** Searches, saves interests, receives opt-in alerts, sends offers, accepts counteroffers, and checks out.  
**Seller:** Publishes listing, confirms details, receives buyer offers, counters/accepts, and marks unavailable.  
**Marketplace operator:** Defines the market/category associated with a phone number, moderates listings, views activity.  
**External agent/provider:** A Darwin-discovered capability that may help with a request; interaction requires route-readiness and authorization checks.

**Initial logical marketplaces:**
- `furniture`: desks, chairs, home goods.
- `creative`: artwork, posters, design services.

Native listings may be cross-listed/discovered across marketplaces if the seller allows it. A query submitted within `creative` can therefore surface a suitable `furniture` listing; results must show their source.

## 4. Critical Dial demo constraint

Dial's SpeedHacks quickstart says that SMS is immediately supported **Dial-number to Dial-number**. Texting ordinary personal phones needs business registration (10DLC). The team has **two Dial-managed numbers**, so it cannot truthfully demonstrate three independent phone participants (buyer, seller, marketplace gateway) using SMS-only messaging.

**Demo configuration:**
- `DIAL_NUMBER_A` = PingMarket SMS service endpoint.
- `DIAL_NUMBER_B` = consenting SMS test participant, used as a seller for the main end-to-end run.
- A web-based buyer simulator/dashboard submits buyer queries and offers against the **same** backend API; a buyer-by-SMS flow can be demonstrated separately by temporarily switching the persona of Number B in an isolated/reset test.
- The two logical marketplaces exist in the database and are available to search; physical phone-number-per-marketplace routing is a **future configuration**, not a claimed live feature in this two-number demo.
- Clearly label dashboard messages as simulated buyer input. Do not imply they arrived from a third real phone.

**Production design:** Additional Dial phone numbers can be mapped to marketplace IDs, with actual consumer SMS enabled only when Dial/carrier registration and consent requirements are satisfied.

## 5. Primary user journeys

### Journey A — Seller publishes by SMS (P0)
1. Seller on Number B sends to Number A: `SELL oak desk, $120, Berkeley. Pickup only.`
2. Dial delivers a `message.received` event.
3. PingMarket validates and deduplicates the event, classifies `CREATE_LISTING`, extracts attributes, and requests clarification only if a required field is missing.
4. Seller receives confirmation: `Listed #D42: Oak desk — $120 — Berkeley. Reply EDIT D42 ... or REMOVE D42.`
5. Listing becomes visible to cross-market search; its provenance is `native`.

### Journey B — Search across native listings + Darwin (P0)
1. Buyer enters or texts: `Looking for a desk under $150 in Berkeley; also interested in custom wall art.`
2. Search orchestrator performs **parallel searches**:
   - Native listings from PingMarket's database.
   - Darwin Search for relevant seller/product/service agent capabilities.
3. Results are normalized into two clearly labeled classes: `Native listing` and `External agent / capability`.
4. Native listings can be offered on inside PingMarket. External capabilities show name, relevance, readiness, and any disclosed setup/uncertainties; PingMarket does **not** imply a guaranteed quote or checkout.
5. Buyer chooses `DETAILS D42`, `OFFER D42 100`, or `AGENT 1` to inspect an external capability.

### Journey C — Negotiation (P0)
1. Buyer offers `$100` on listing `D42` from the buyer simulator (or from SMS in a separate role-switched test).
2. PingMarket sends the seller an SMS: `Offer #O7: $100 for D42. Reply ACCEPT O7, COUNTER O7 110, or DECLINE O7.`
3. Seller replies `COUNTER O7 110`.
4. Buyer dashboard shows `$110 counteroffer`; buyer accepts.
5. Negotiation transitions to `accepted` and an order is created with `$110` **pending payment**.
6. If Stripe is implemented, generate a test-mode Checkout link. Mark `paid` only after the server verifies the Checkout Session with Stripe using the secret key (on return from Checkout, on demand, or via an optional signed webhook); never on link generation or the redirect URL alone.

### Journey D — Interest alert (P1)
1. Buyer explicitly opts in: `ALERT: office chair, <=$100, Berkeley` (or checks an opt-in in dashboard).
2. Seller publishes a qualifying listing.
3. Matcher evaluates saved interests and sends one relevant message to the opted-in user when the channel is permitted.
4. `STOP` unsubscribes the buyer from alerts; no further marketing notifications are sent.

## 6. Product requirements and acceptance criteria

| ID | Priority | Requirement | Acceptance criteria | Owner |
|---|---|---|---|---|
| PM-01 | P0 | Dial ingestion | Valid incoming SMS is stored once and acknowledged despite webhook retries | A |
| PM-02 | P0 | SMS intent parser | Recognizes SELL, SEARCH, OFFER, COUNTER, ACCEPT, DECLINE, REMOVE and HELP; asks clarification for incomplete listing | A |
| PM-03 | P0 | Listing from SMS | A structured, seller-owned listing is created and confirmed by return SMS | A |
| PM-04 | P0 | SMS negotiation | Seller receives an offer and returns counter/accept; only authorized participant changes the deal | A |
| PM-05 | P0 | Native search | Searches both logical marketplaces with category, price, and text filters | B |
| PM-06 | P0 | Darwin Search | Live POST to Darwin public Search returns actual agent results or a truthful no-match response | B |
| PM-07 | P0 | Source-aware ranking | Native listings and Darwin capabilities are labeled differently; no fabricated inventory, quotes or confidence | B |
| PM-08 | P0 | Search API contract | A sends normalized intent, B returns typed results; both work without each other's UI code | Both |
| PM-09 | P0 | Demo dashboard | Live listings, queries, external results, negotiation state and SMS event trace appear | B |
| PM-10 | P1 | Interest notifications | Only opt-in interests trigger matching notifications, with deduping/STOP support | A + B |
| PM-11 | P1 | Stripe test checkout | One pending order -> test Checkout -> server verifies the session with Stripe (secret key; optional signed webhook) -> paid; no exposed card details in SMS | B |
| PM-12 | P1 | Keewano decision loop | Typed events are ingested and a live query changes an app decision or displayed recommendation | B |
| PM-13 | P1 | Sparta verification | Reproducible, supported Stripe-operation test with before/after evidence | A or B after P0 |
| PM-14 | P1 | Alike handoff | Shared coding-agent decision is recorded and surfaced in a separate session (access permitting) | Both |

## 7. Two-person work allocation

### Developer A — Dial, messaging, and negotiation (about 50%)

**Owns:** Telephony adapter, inbound messages, sender identities, SMS prompts, seller onboarding, listing-creation flow, negotiations, consent/STOP, and event security.

**Files / modules:**
- `src/app/api/dial/webhook/route.ts`
- `src/lib/dial/client.ts`
- `src/lib/sms/intent.ts`
- `src/lib/sms/router.ts`
- `src/lib/negotiation/service.ts`
- `src/lib/notifications/service.ts` (P1)

**Deliverables:**
1. Dial account configuration with two numbers and successful Dial-to-Dial SMS test.
2. HTTPS webhook subscription, HMAC signature check, event-ID deduplication and safe retry behavior.
3. Intent extraction with deterministic handling for transaction-affecting commands.
4. `SELL` -> structured listing -> SMS confirmation.
5. `OFFER` -> seller reply -> `ACCEPT` / `COUNTER` / `DECLINE` state machine.
6. `POST /api/internal/sms/simulate` or equivalent demo-only input, clearly marked, for browser-based buyer interaction.

**Acceptance test:** Send a real SMS from Number B to Number A and see one native listing created; seller then receives and counters a simulated buyer offer through actual Dial SMS.

### Developer B — Darwin, data, discovery, and dashboard (about 50%)

**Owns:** Postgres/Supabase schema, native multi-marketplace search, Darwin Search adapter, external-result normalization, ranking, buyer dashboard, and optional checkout.

**Files / modules:**
- `src/app/api/search/route.ts`
- `src/lib/darwin/search.ts`
- `src/lib/search/merge.ts`
- `src/lib/db/schema.ts` (or SQL migrations)
- `src/app/dashboard/page.tsx`
- `src/lib/payments/stripe.ts` (P1)
- `src/lib/analytics/keewano.ts` (P1)

**Deliverables:**
1. Database schema and 6–10 seeded native listings split across `furniture` and `creative`.
2. `/api/search` returning a combined typed result set from native DB and live Darwin Search.
3. Darwin response cards with actual agent identity, capability ID, readiness, uncertainties and routing/connection information where returned.
4. Browser dashboard for seller listings, buyer queries, offers, source-labeled results and event state.
5. Native match API called by Developer A's SMS router.
6. Optional Stripe Checkout integration after the end-to-end core flow passes.

**Acceptance test:** Submit one buyer query; see a real native match from a different logical marketplace plus a live Darwin Search result/no-match outcome, correctly labeled, then create an offer through the shared API.

### Shared rules

- Use **one repository** with two feature branches: `feat/dial-messaging` and `feat/darwin-discovery`.
- Freeze shared types and database keys in the first 30–45 minutes. Do not develop incompatible `Listing`, `SearchResult`, or `Offer` shapes independently.
- Neither workstream directly edits the other's core module without coordination.
- Merge small working commits early. Integration occurs by hour 4, not at the end.
- Use one simple LLM intent parser if needed; never allow arbitrary LLM output to perform payments or send unsolicited SMS without validated commands/consent.

## 8. Shared API contract — agree before coding

### `POST /api/search`
```json
{
  "query": "desk under $150 near Berkeley",
  "marketplaceId": "creative",
  "maxPriceCents": 15000,
  "location": "Berkeley",
  "includeExternalAgents": true
}
```

**Response** (illustrative shape; actual content is dynamic):
```json
{
  "nativeListings": [
    {
      "type": "native_listing",
      "id": "D42",
      "marketplaceId": "furniture",
      "title": "Oak desk",
      "priceCents": 12000,
      "location": "Berkeley",
      "status": "available"
    }
  ],
  "externalCapabilities": [
    {
      "type": "darwin_capability",
      "agentId": "<from-Darwin>",
      "capabilityId": "<from-Darwin>",
      "capabilityRevision": "<from-Darwin-if-returned>",
      "name": "<from-Darwin>",
      "readiness": "<from-Darwin>",
      "canStartThread": false,
      "uncertainties": [],
      "connectionPrompt": "<from-Darwin-if-returned>"
    }
  ]
}
```

Darwin adapter should use `POST https://api.darwin.so/api/v3/search` with `{ "query": "...", "maxResults": 5 }` for public discovery. Persist exact returned IDs and revisions; never generate IDs from agent names. Darwin Search is read-only, and agent communication/transactions are gated on a supported route and additional authorization.

### Negotiation commands

- `POST /api/offers` — creates an `open` buyer offer for one available listing.
- `POST /api/offers/{offerId}/counter` — seller-only; records new price; state `countered`.
- `POST /api/offers/{offerId}/accept` — recipient of the current offer accepts; state `accepted`.
- `POST /api/offers/{offerId}/decline` — recipient declines; state `declined`.

**Invariants:** Prices are positive integer cents; ownership comes from authenticated actor or mapped SMS identity; accepting is idempotent; SMS webhook retries cannot duplicate offers/orders; unavailable listings cannot receive new offers; `accepted` does not mean `paid`.

### Database tables

`marketplaces(id, name, category, dial_number nullable)`  
`users(id, phone, role, consent_status)`  
`listings(id, marketplace_id, seller_id, title, description, price_cents, currency, location, status, visibility)`  
`interests(id, buyer_id, query, max_price_cents, location, enabled)`  
`offers(id, listing_id, buyer_id, seller_id, proposed_price_cents, status, last_actor_id, expires_at)`  
`messages(id, dial_event_id unique, from_number, to_number, body, direction, created_at)`  
`orders(id, offer_id unique, amount_cents, payment_status, stripe_checkout_session_id nullable, paid_at, stripe_payment_intent_id, payout_status, stripe_transfer_id, payout_amount_cents, payout_currency, platform_fee_cents, payout_error, payout_at)`; `users.stripe_account_id` (test connected account)  
`agent_searches(id, query, darwin_search_id nullable, result_metadata, created_at)`

Use normalized records for transactions; do not use Keewano as the transactional source of truth.

## 9. System architecture

```text
Dial Number A <----SMS----> Dial Number B (demo participant)
        |
        v
  Signed Dial webhook
        |
        v
   Dedup + intent router  <------ Buyer demo dashboard
        |                           |
        +---- SELL ----------------> Native listings (Supabase)
        +---- OFFER/COUNTER -------> Negotiation state machine
        +---- SEARCH -------------> Shared search orchestrator
                                       |                 |
                                       v                 v
                                  Native SQL         Darwin Search
                                       |                 |
                                       +--- Typed results+
                                                |
                                                v
                                       SMS / dashboard reply

Optional: Keewano event-driven insights | Stripe test checkout
Independent tests: Sparta Worlds | Dev coordination: Alike
```

## 10. Time plan — 12-hour hackathon

| Elapsed | Developer A | Developer B | Team checkpoint |
|---|---|---|---|
| 0:00–0:45 | Dial credentials, numbers, webhook setup | Repo, database, shared types, Darwin probe | Lock API contract and scope |
| 0:45–2:30 | Receive/verify SMS; implement `SELL` | Native schema, seed data, Darwin Search client | Real SMS recorded; Darwin result fetched |
| 2:30–4:00 | SMS intent router + listing writes | Unified `/api/search` + dashboard | **First integration**: SMS-created listing can be searched |
| 4:00–6:30 | Negotiation SMS notifications/state transitions | Buyer search/offer UI; external agent cards | Offer -> counter -> accepted works |
| 6:30–8:00 | SMS reliability, STOP/HELP, error handling | Source labeling, relevance filters, interface polish | Freeze P0 and rehearse complete path |
| 8:00–10:00 | Interest notification OR Sparta test | Stripe test checkout OR Keewano live query | Add P1 only if P0 is stable |
| 10:00–12:00 | Regression tests, demo data, handoff | Demo polish, recording, submission | Final live rehearsal and backup video |

**Cut rule:** If P0 is not stable by hour 8, stop P1 work. Never trade away real Dial messages and real Darwin Search for optional integrations.

## 11. Testing, edge cases, and safety

- **Dial:** Validate webhook HMAC against the raw body and reject stale signatures; deduplicate by `X-Dial-Event-ID`; account for at-least-once delivery. Handle SMS send failures and missing required fields.
- **Loop avoidance:** Distinguish application-generated messages from human-originated commands so Dial-to-Dial messages do not create infinite reply loops.
- **Privacy:** Store phone numbers and message bodies securely; do not log plaintext secrets or expose buyer/seller phone numbers to each other by default.
- **Consent:** Require opt-in before interest alerts, enforce `STOP`, avoid cold outreach, and keep the hackathon demo on permitted Dial-to-Dial messages.
- **Negotiation:** Require listing ID and offer ID, participant authorization, an explicit price, clear expiry and idempotent state changes.
- **Darwin:** Treat search results as capabilities, not verified products; show uncertainty and readiness; do not automatically execute provider actions or charge buyers.
- **Stripe (P1):** Only hosted test-mode payment page; Mark `paid` only after the server verifies the Checkout Session with Stripe using the secret key (on return from Checkout, on demand, or via an optional signed webhook); never on link generation or the redirect URL alone. Seller payouts are test-mode Stripe Connect transfers (separate charges and transfers, funded by the order's charge); no live payouts.
- **Availability:** Mark listings sold/reserved consistently; an accepted offer must not enable two contradictory sales.

## 12. Final demo script (3–5 minutes)

1. **Seller by real SMS:** Number B texts Number A: `SELL oak desk, $120, Berkeley, pickup only.` Listing #D42 appears in dashboard.
2. **Cross-market search:** Buyer dashboard, scoped to Creative Market, asks for `desk under $150 and designer for custom art`. PingMarket finds #D42 from Furniture Market and separately fetches Darwin agent capabilities.
3. **Source transparency:** Show one native listing versus a Darwin-discovered external capability; explain that only native listing #D42 is currently negotiable inside PingMarket.
4. **Negotiation:** Buyer proposes `$100` from dashboard. Seller receives real SMS on Number B, counters `$110` by SMS. Buyer accepts in dashboard; order becomes pending payment.
5. **Optional payment:** Show Stripe test checkout and verified success. Otherwise stop honestly at `accepted / payment pending`.
6. **Optional sponsor proof:** Run a live Keewano insight affecting an alert/ranking decision, or a separate Sparta test that verifies a supported agent operation. Show Alike session handoff only if configured.

**Pass/fail definition:** A fresh listing must be created from live Dial SMS, returned by cross-market native search, displayed alongside an actual Darwin Search result/no-match, and reach an accepted counteroffer without manual database editing. If any one fails, the P0 demonstration is incomplete.

## 13. Measurable success criteria

- End-to-end native listing creation via Dial SMS: **1 real success**.
- Live Darwin search executed during demo: **1 real response**, including valid no-match.
- Native cross-market search: **1 listing discovered outside the buyer's current marketplace**.
- Negotiation: **1 buyer offer, 1 seller counter, 1 acceptance** with correct final state.
- Reliability: **0 duplicate listings/offers after replaying a Dial event**.
- Measured time saved: compare manual listing + buyer–seller coordination with PingMarket workflow; report actual observed demo duration and label any assumed baseline.

## 14. Risk register and decisions

| Risk | Impact | Mitigation |
|---|---|---|
| Only two Dial numbers; personal SMS restricted | High | One SMS seller + web buyer demo; honest persona-switched separate SMS test |
| Darwin returns general-purpose agents instead of seller offers | High | Show agent-capability results distinctly; search specific product/provider prompts; allow no-match |
| Authentication/Act unavailable for Darwin execution | Medium | Treat public Search as P0; agent-to-agent negotiation as future scope |
| SMS loops or webhook retries produce duplicate actions | High | Event dedup, outbound-message suppression, idempotent mutations |
| Hard to implement Stripe Connect and actual payouts | Medium | Stripe test-mode Checkout only; no real settlement |
| Too many sponsor integrations dilute core | High | Dial + Darwin first; add others behind clear P1 gates |
| Seller notifications lack opt-in | High | Use only consenting demo numbers; explicit consent and STOP for future subscriptions |

## 15. Official reference materials

- Dial SpeedHacks quickstart: https://getdial.ai/hackathon/speedhacks/quickstart
- Dial webhooks: https://docs.getdial.ai/documentation/platform/webhooks
- Darwin Quickstart: https://darwin.so/docs/get-started/quickstart
- Keewano SpeedHacks quickstart: https://docs.keewano.com/getting-started/speedhacks-quickstart
- Uploaded sponsor one-pagers: *Darwin SpeedHacks One Pager*, *Sparta — ONE_PAGER*, *Alike early access*.
