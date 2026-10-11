# Developer A — messaging handoff

Branch: `feat/dial-messaging`. Status: messaging modules tested and the live Dial PING/reply round trip verified on October 11, 2026. Shared application contracts remain proposals awaiting Developer B review. No marketplace scaffold or application database adapter is included.

A standalone Dial connectivity test is available under `scripts/dial/`, with local durable journaling and configuration checks. See `docs/DIAL_SETUP.md`. It is separate from B's application database. A signed provider ping returned HTTP 200; Number B's PING reached A; A's automatic reply reached B. Dial history reported both outbound sends delivered and corresponding inbound records. The local journal recorded one incoming command and one accepted reply attempt; the reply event was ignored by the router. Sanitized provider evidence is stored privately in `.local/dial/test-evidence.json`.

Run on Node 22.13 or newer:

```sh
npm ci
npm run typecheck:messaging
npm run test:messaging
```

Tests never send an SMS or contact an external database. Connectivity tests use temporary local SQLite journals; webhook, seller-router, and negotiation tests use test-only memory adapters. Deduplication/rollback checks demonstrate the proposed adapter contracts, not production database uniqueness, concurrency, or crash recovery. All 47 tests and messaging type checking pass.

**Implemented modules**

| File | Responsibility |
|---|---|
| `src/lib/dial/signature.ts` | Constant-time HMAC verification over exact bytes; five-minute timestamp window; malformed signatures fail safely |
| `src/lib/dial/webhook.ts` | Framework-neutral Request/Response handler; signed envelope validation, service/participant filtering, durable-inbox boundary |
| `src/lib/dial/client.ts` | Dial SDK transport; recipient allowlist, explicit send enablement, one attempt, safe result classification |
| `src/lib/sms/intent.ts` | Pure command/listing parsing and missing-field clarification; no side effects |
| `src/lib/sms/ports.ts` | Proposed inbox/sender interfaces and extracted draft shape; no database schema |
| `src/lib/sms/router.ts` | Seller routing, draft lifecycle, validation, trusted ownership/visibility, and proposed atomic processing boundary |
| `src/lib/negotiation/service.ts` | OFFER/COUNTER/ACCEPT/DECLINE authorization, expiry/version checks, and proposed atomic reservation/order boundary |

**First contract to agree: inbound storage**

`SmsInbox.receive(message)` returns `stored` or `duplicate` only after durable persistence succeeds. It must atomically deduplicate both provider event and message IDs and make new messages available for recoverable processing. Existing records are immutable under duplicate receipt. Concurrent duplicates must not enqueue multiple jobs. A persistence failure rejects the promise, causing HTTP 503 so Dial can retry.

Fields supplied to B's adapter:

| Field | Meaning |
|---|---|
| `eventId`, `messageId` | Provider identifiers; preserve exactly |
| `from`, `to`, `body` | Incoming SMS data; sensitive server-side values |
| `occurredAt` | Provider event time; not proof of delivery order |
| `source` | Always `dial_sms` for this handler |
| `providerSource` | `external`, `internal`, or `unknown`; preserve Dial's distinction |

B owns storage/schema and supplies the adapter through dependency injection. A owns application routing and tests. Resolve runtime/job execution together: there is no custom worker or background processing in this change. The adapter must not perform slow model/provider work before acknowledging receipt, and merely saving a row does not complete domain processing.

After B provides the scaffold and durable inbox, the route wiring can be as small as:

```ts
// Integration example only; this is not a deployed endpoint.
export const POST = createDialWebhookHandler({
  signingSecret: configuration.webhookSecret,
  serviceNumber: configuration.serviceNumber,
  allowedParticipants: configuration.demoParticipants,
  inbox: durableSmsInbox,
});
```

Mount at `/api/dial/webhook` using the Node runtime. Subscribe to `message.received` at a public HTTPS URL. The handler acknowledges signed pings/unrelated events and ignores messages sent to other numbers. It does not assign a seller role to an allowed number; identity and role resolution happen in the application router.

Returns: 200 for saved/duplicate/ignored events, 400 for invalid payloads or mismatched headers, 401 for invalid signatures, 405 for non-POST, 413 above 64 KiB, and 503 when the inbox cannot save. It validates the installed SDK's version-1 event envelope; capture a real provider sample during the first live setup check.

**Outbound boundary**

Construct `createDialSender` with a server-only API key, Number A's Dial resource ID, permitted recipient numbers, and an explicit `enabled` flag. No environment variables are read implicitly. Tests inject a fake SDK transport.

Before calling `send`, the application must persist the outbound intent and mark the attempt in progress. `accepted` means Dial returned a message ID, not that the recipient received it. `unknown` means the outcome needs reconciliation and must not be retried automatically. A crash after sending has the same ambiguity. `blocked` means no provider call occurred. This transport does not implement durable attempts, automatic recovery, delivery receipts, or a timeout policy; agree those with the application runtime before live use.

**Parser boundary**

The parser recognizes SELL, SEARCH, OFFER, COUNTER, ACCEPT, DECLINE, REMOVE, DETAILS, EDIT, AGENT, HELP, STOP, and CANCEL. Recognition is not execution. EDIT returns change text that still needs validation. AGENT indices need actor-scoped, expiring search results. Transaction commands require explicit IDs and prices where relevant.

Supported listing forms include both PRD examples and `I'd like to sell my oak desk for $120 in Berkeley, pickup only.` Prices are parsed into integer cents without rounding. This initial adapter is rule-based, not a general natural-language interpreter. Unfamiliar wording may be unrecognized or need rephrasing; broader extraction remains open. A parser result never supplies seller identity, marketplace, or cross-market consent.

`clarifyListing` fills a missing field from an existing draft; it does not save the draft or enforce its expiry/order. A's router must load a validated draft scoped to the participant/service, enforce expiry, and handle command interruptions explicitly. State-changing parser results always pass through authorization and application services.

**Remaining agreements and work**

The standalone negotiation service now implements the $100 offer → $110 seller counter → buyer acceptance path, plus direct seller acceptance and recipient decline. It is not wired to the SMS router or HTTP routes yet. All 47 messaging tests and type checking pass. The seven negotiation tests use a serializing memory adapter, including competing acceptance and rollback checks; they do not prove production database concurrency.

`createNegotiationService(store, { offerLifetimeMs, now? })` requires an explicit positive offer lifetime; counters retain the original deadline. `execute(requestId, command)` accepts integer cents and provisional D/O public codes. Transitions require `expectedVersion`; HTTP adapters must validate request bodies and use the buyer's observed version. Plain SMS does not contain a version: agree how the inbox records the proposal being answered before wiring SMS transitions, rather than silently replacing a stale version with the latest one.

`NegotiationStore.execute` resolves an authenticated actor from trusted integration context and preserves `dial_sms` versus `buyer_simulator` provenance. Scope idempotency by actor/source/request ID, bind the key to the command, reject changed-input reuse, and persist the result with all writes and notification intents. Use stable provider message IDs for SMS requests. Notifications are stored activity/outbound intents, not immediate sends; route simulated-buyer updates to the dashboard and permitted real-participant updates to SMS.

Acquire listing locks before offer locks, shared with EDIT/REMOVE. Under that lock, acceptance reserves the available listing, creates exactly one pending-payment order at the accepted price with the offer's participants, and closes competing actionable offers. Enforce unique order-per-offer storage and increment versions when closing competing offers. Return the authorized existing order on repeated acceptance without repeating notifications. An offer's author cannot accept/decline their own proposal; only the seller may counter an open buyer offer. Additional bargaining rounds are outside this slice.

The seller slice can now be exercised through `createSellerRouter(store).process(eventId)`. `SellerMessageStore.process` must load the immutable received message, resolve the actor from its sender/service context, serialize each conversation, and deduplicate both provider identifiers before invoking the callback. Commit listing creation, draft changes, queued reply, and event completion together. Roll back everything on failure. Do not send SMS inside the callback; transaction retries must not send messages. B supplies the application adapter and recovery mechanism.

Drafts are scoped by participant and service, expire 30 minutes after starting (clarifications do not extend expiry), and are replaced by a new SELL. HELP and other explicit commands preserve the draft; CANCEL clears it. Older provider timestamps are rejected with a resend prompt; equal timestamps follow serialized receipt order. This is a conservative late-message policy, not proof of provider ordering. Confirm this policy with B.

Created listings use USD, available status, and marketplace-only visibility by default. Cross-market visibility requires a server-resolved recorded consent ID; the router does not collect that consent yet. Seller identity and furniture/creative marketplace come from trusted context. Codes currently require uppercase D-prefixed identifiers, pending shared agreement. No schema or application runtime is introduced.

SELL, clarification, CANCEL, HELP, EDIT, REMOVE, and STOP execute in this slice. Other recognized commands report that they are not connected and never become missing listing fields. Search and negotiation remain subsequent work. The existing live connectivity harness still only responds to PING; application storage and provider opt-out integration are not wired.

EDIT changes one field per message: `EDIT D42 price $100`, `EDIT D42 title Oak desk`, `EDIT D42 location Oakland`, or `EDIT D42 description Pickup after 5`. Other fields cannot be edited. REMOVE soft-removes the listing; repeated removal reports it already removed. Both actions require the resolved seller's ownership and available status, and are blocked if active offers exist. This conservative policy is proposed for B review; it does not silently invalidate offers.

`lockListing` must hold a listing-level lock through commit. Offer creation and acceptance must use the same lock and recheck listing status/terms, including when there were zero offers at read time. `hasActiveOffers` must include open and countered offers that remain actionable. Locking existing offer rows alone does not prevent a new offer racing with removal. Update and confirmation roll back together. The memory fixture does not prove database concurrency safety; B's adapter needs an integration test for this race.

STOP invokes `disableAlerts` for the resolved participant, even for late messages, without lowering the conversation timestamp or changing draft/listing sharing consent. The adapter must disable alerts and cancel all unsent marketing intents atomically with event completion. The dispatcher must recheck consent before sending marketing; an already in-flight provider send cannot be recalled by this contract. No STOP reply is queued by this router, and ordinary commands never re-enable alerts. Provider-specific opt-out and transactional delivery behavior must be integrated before live use. This change supplies the business boundary, not a production notification dispatcher.

1. B confirms the framework/runtime, ID/public-code formats (D/O prefixes are provisional), authenticated buyer context, and persistence interface. A does not create B's schema or migrate the database.
2. Review the implemented seller router's proposed transaction interface, listing fields, consent reference, draft expiry, ordering, listing locks, and STOP cancellation requirements. B implements durable storage; A wires it into the agreed runtime and checks provider opt-out handling.
3. Review the implemented negotiation service and atomic acceptance/idempotency contract. B supplies persistence; A still implements offer endpoints, SMS delegation with proposal-version handling, and the protected buyer simulator in the shared runtime.
4. B supplies native/Darwin search and dashboard; A supplies normalized input, source-aware SMS formatting, and event provenance. Preserve the PRD's shared search response shape.
5. Two Dial numbers, the webhook signing secret, and the live inbound/reply test are configured and verified. The remaining live tests are listing creation and negotiation against B's application database. Those are required to close the marketplace PRD milestones.

No application migrations, seed data, search implementation, dashboard, payment integration, or production in-memory fallback is part of this branch's messaging modules.
