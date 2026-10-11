# PingMarket — Developer A implementation plan

Source of truth: `PingMarket_PRD_v1.md`, especially sections 6–8. This plan is for Developer A: Dial, messaging, seller listing actions, identity, and negotiation. Developer B owns the database/schema, discovery, and dashboard. The original PRD is unchanged.

**Review of the original plan**

The PRD is a solid MVP specification: it names an observable end-to-end outcome, separates P0 from optional integrations, distinguishes native inventory from external capabilities, and accounts for the two-number demo. Keep the first integration by hour 4 and the P0 cut rule at hour 8.

The previous implementation plan was reasonable as a team roadmap, but not ready to execute as Developer A alone:

| Finding | Correction |
|---|---|
| Team-wide phases blurred ownership; implementation crossed into B's schema/scaffold work. | Limit this branch to A-owned modules. Treat B's deliverables as dependencies, not tasks to take over. |
| A private Postgres schema, direct SQL client, extra tables, and persistent worker were selected before agreement. | Define transaction/recovery requirements first. Agree on persistence and runtime with B before choosing implementation details. |
| Natural-language listing creation was described, but the initial parser required rigid comma-separated input. | Test both PRD examples and free-form wording. A strict listing template alone does not satisfy P0. |
| Commands were listed without staging them, and simulator ownership was unclear. | Prioritize the real listing and negotiation flows. A owns simulator/offer endpoints; B owns UI and supplies agreed authenticated actor context. |
| Cross-market consent and the two-number test setup were insufficiently explicit. | Obtain or record the demo seller's permission before cross-market discovery. Verify actual account/number setup. |
| Recovery semantics were useful, but their operational cost was understated. | Retain durable receipt, atomic writes, and safe sends; time-box runtime decisions and avoid general-purpose queue infrastructure. |

Resolve small PRD ambiguities at kickoff: it advertises EDIT and AGENT outside the core parser acceptance list; SELL examples use both periods and extra commas; seller opt-in timing is undefined. Make these explicit acceptance cases, not accidental product decisions.

**Ownership and working boundary**

| Developer A implements | Developer B supplies | Agree together |
|---|---|---|
| Dial adapter and signed webhook | App scaffold and database connection conventions | Shared IDs, types, errors, actor shape |
| SMS extraction, clarification, replies | Schema, migrations, seeds, persistence interface | Durable receipt, recovery, send-attempt records |
| Seller listing business actions | Native search and Darwin integration | Visibility/consent and marketplace routing |
| Offer state machine and HTTP routes | Dashboard and buyer controls | Authenticated buyer context and simulator protection |
| Demo simulator endpoint and SMS identity | Dashboard activity/listing/offer reads | Provenance and request idempotency |
| STOP/HELP, A-side tests and runbook | Stripe and Keewano integration | Atomic reservation/order semantics |

Target branch when implementation resumes: `feat/dial-messaging`. Do not implement migrations, seed catalogs, Darwin search, ranking, dashboard pages, Stripe, or a separate application scaffold on A's branch. Shared infrastructure changes require coordination. The two-human work allocation does not imply agent delegation.

1. **Agree on integration contracts — first 30–45 minutes**

   Confirm B's scaffold/runtime and exchange types before wiring persistence. Use small interfaces and fixtures to test A's business logic while B builds the real adapter. Fixtures are test-only and do not count as live integration or durable storage.

   Freeze these decisions:

   - `Actor`: server-resolved participant ID, input source (`dial_sms` or `buyer_simulator`), and permitted marketplace context. Never trust ownership claims in text or client-supplied user IDs.
   - `Listing`: ID/public code, seller, marketplace, title, description, integer price cents, USD, location, availability, and cross-market permission. Agree whether the public code is the ID or a separate field.
   - `SearchRequest`/`SearchResponse`: use the PRD shape; retain separate native/external results and distinguish no-match from provider failure. A calls B's search service and formats replies.
   - `Offer`: IDs/participants, current price, current proposal's actor, status, expiry, and version. Define idempotency for webhook retries and repeated browser commands.
   - Persistence operations: resolve participant; durably receive/claim an event; load/save a draft; create/edit/remove a listing; atomically mutate an offer/reserve a listing/create an order; enqueue and record SMS attempts.
   - Transaction boundary: domain writes, event completion, and intended outbound replies commit together. B supplies database implementation; A defines required behavior and integration tests.
   - Runtime: bounded inline processing is acceptable only if it safely fits the webhook response budget. Work continuing after acknowledgement needs an agreed durable job mechanism and recovery. Never launch untracked background promises or mandate a custom worker without agreement.

   **Done:** concrete contracts exist with owners for shared dependencies. Missing infrastructure does not prevent isolated signature/parser/service tests.

2. **Prove Dial inbound and outbound — hours 0:45–2:30**

   Implement `src/lib/dial/client.ts` and `src/app/api/dial/webhook/route.ts`, with focused helpers/tests under A-owned paths.

   Confirm the account's two number IDs and E.164 values. Number A is the service endpoint; Number B is the consenting test participant. Verify permitted Dial-to-Dial delivery and how the participant sends from Number B. Provisioning, subscription setup, and live test messages are explicit setup actions, not hidden test side effects.

   Verify HMAC against the raw body, reject malformed/stale signatures, validate the envelope, and deduplicate by Dial event ID. Where available, also protect against distinct envelopes referring to one provider message. Acknowledge only after durable receipt; return a retryable error if persistence fails. Valid webhook pings create no marketplace action.

   Route only traffic addressed to Number A from permitted participants. Replies arriving at Number B must not re-enter the command router. Do not permanently equate Number B with a seller role: the PRD includes an isolated buyer-persona test.

   Persist outbound intent and attempts. Distinguish queued, accepted by Dial, delivery confirmed where available, failed, and unknown outcomes. Do not automatically retry ambiguous SMS sends or claim exactly-once carrier delivery. Exclude credentials and sensitive provider errors from logs.

   **Done:** one real inbound SMS is saved and an authorized reply is sent; replay causes no duplicate application action. Fixture tests alone do not close this milestone.

3. **Build the seller listing flow — hours 2:30–4:00**

   Implement `src/lib/sms/intent.ts`, `src/lib/sms/router.ts`, and A-owned listing business logic through B's persistence interface.

   Accept both PRD examples: `SELL oak desk, $120, Berkeley. Pickup only.` and `SELL oak desk, $120, Berkeley, pickup only.` Extract location and pickup details separately. Also test natural wording: `I'd like to sell my oak desk for $120 in Berkeley, pickup only.` Use a structured extraction adapter if needed; validate its output and never invent missing prices, locations, or consent.

   Parse transaction-changing commands deterministically. Natural-language interpretation must not accept an offer, negotiate autonomously, or authorize a payment.

   Ask only for missing listing fields. Store drafts with participant/service scope, expiry, and CANCEL support. Preserve processing order per conversation so a clarification cannot overtake its initial message; account for provider deliveries arriving out of order.

   Create a seller-owned listing, then enqueue confirmation of its committed public code. Support authorized removal and the simple EDIT flow advertised in the PRD. Confirm seller opt-in or obtain it before cross-market discovery; agree the explicit flow with B.

   **Hour-4 integration check:** the real SMS-created listing is in B's database and returned by B's cross-market search when sharing is permitted. Passing local tests does not close this integration checkpoint.

4. **Connect search and negotiation — hours 4:00–6:30**

   Delegate SEARCH and natural-language buyer queries to B's search contract. Label native and external results separately; never offer on a Darwin capability as native inventory. DETAILS retrieves native listing information. AGENT references the actor's recent search results with expiry, so numbered selections cannot point at another user's results.

   Implement `src/lib/negotiation/service.ts` and the PRD's offer routes. SMS and browser APIs invoke the same service and resolve actors server-side.

   | Action | Authorized participant | Result |
   |---|---|---|
   | OFFER | Buyer other than listing owner | Open offer on available listing; notify seller |
   | COUNTER | Seller receiving open buyer offer | Countered offer with explicit new price; update buyer |
   | ACCEPT | Recipient of current proposal | Accepted offer and one pending-payment order |
   | DECLINE | Recipient of current proposal | Declined offer |

   The required demo is one buyer offer, one seller counter, and buyer acceptance. Additional bargaining rounds are unnecessary before that path works. Validate positive integer cents, IDs, expiry, participant identity, state, and stale versions. Repeated acceptance returns the existing authorized outcome.

   Coordinate B's atomic persistence operation: lock/check availability, reserve the listing, accept the offer, create one order, and close competing offers. Concurrent acceptances cannot sell the same listing twice. Define rejection/closure rules for removal or material listing edits so old offers do not silently apply to changed terms.

   A implements `POST /api/internal/sms/simulate` or the agreed equivalent, gated to the demo and authenticated buyer. B provides UI. Preserve `buyer_simulator` provenance for labeling; never manufacture a Dial event or let callers impersonate sellers.

   **Done:** buyer offers $100 through the browser/API, Number B receives the SMS and counters $110, and buyer acceptance creates exactly one $110 pending-payment order. A can test the API before B's UI is ready; the UI remains an integration dependency.

5. **Verify reliability and hand off — hours 6:30–8:00**

   Test forged/malformed/stale signatures, event replay, receipt persistence failures, crash recovery after acknowledgement, duplicate outbound intent, unknown send outcomes, reply loops, clarification expiry/order, free-form SELL, unauthorized changes, invalid prices, stale/expired offers, and concurrent acceptance.

   Add HELP and STOP. STOP disables alert consent and future marketing notifications; interest matching remains P1. Coordinate transactional replies with the provider's actual opt-out behavior rather than promising delivery after STOP.

   Give B route payloads, response/error examples, provenance fields, public IDs, and activity statuses. Document A's environment variables, subscription setup, runtime/start commands, permitted participants, and recovery procedure. Do not include secrets.

   **P0 gate:** jointly rehearse the full PRD demo. A proves real SMS listing creation, offer notification, seller counter, correct acceptance, and no duplicate domain writes on replay. B proves live native/Darwin discovery and dashboard behavior. Neither side's fixtures substitute for the live demo.

6. **Only after P0 passes — remaining time**

   A may add the notification service with B's interest matcher, opt-in, deduplication, and STOP, or take the optional Sparta test. Stripe, Keewano, and their UI remain B's work. If P0 is unstable at hour 8, stop optional work. Reserve the final two hours for regression checks, rehearsal, and handoff.

**Next implementation action**

Started `feat/dial-messaging`. Signature verification, an injectable webhook handler, a single-attempt Dial sender, and initial parser/clarification functions are implemented. Type checking and 28 tests pass, including local journal restart/deduplication checks. On October 11, 2026, the signed webhook ping returned HTTP 200 and the live Number B → A PING / A → B reply completed, with both deliveries confirmed in Dial history. This proves Dial connectivity using the local test journal; the shared application inbox contract and marketplace database integration remain open.

The initial seller router is now implemented in `src/lib/sms/router.ts`: SELL, missing-field questions, scoped 30-minute drafts, CANCEL, HELP, listing validation, trusted seller/marketplace/consent context, and queued confirmation. It rejects messages older than the conversation watermark rather than applying them to newer drafts. The proposed transaction adapter groups listing/draft writes, outbound intent, and event completion; a test-only adapter demonstrates rollback and duplicate handling. Type checking and all 35 messaging tests pass. No live marketplace integration is claimed.

The next completed slice adds seller-only EDIT/REMOVE and STOP through the transaction interface. EDIT supports one validated title, price, location, or description field per message. Edits/removals are blocked for active offers or unavailable listings; removal is repeatable. The proposed adapter must lock listings against concurrent offer creation/acceptance. STOP disables alerts and cancels pending marketing intents through the adapter, including for late messages, without queuing a reply. All 40 messaging tests and type checking pass; real database concurrency and provider opt-out behavior remain integration checks.

Next, have B review `SellerMessageStore` and supply its durable implementation, then wire processing into the shared application runtime. Confirm the conservative active-offer policy (block edits/removal until offers are resolved), listing locking, notification consent enforcement, and provider opt-out handling. Search, negotiation, and the live hour-4 integration check remain open. See `docs/DEVELOPER_A_HANDOFF.md` for module boundaries and adapter requirements. Do not substitute fixtures for durable persistence or live-demo evidence.

**Review references**

- [Dial webhooks](https://docs.getdial.ai/documentation/platform/webhooks): signature verification, stable event IDs, and retry/acknowledgement behavior.
- [Dial Node SDK](https://docs.getdial.ai/documentation/sdks/node): SMS operations and duplicate-send risk on retries.
- The PRD's two-number restriction remains an account/setup check. No third phone participant or unrestricted consumer SMS is assumed.
