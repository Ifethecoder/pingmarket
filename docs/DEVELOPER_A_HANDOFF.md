# Developer A — messaging handoff

Branch: `feat/dial-messaging`. Status: messaging modules tested and the live Dial PING/reply round trip verified on October 11, 2026. Shared application contracts remain proposals awaiting Developer B review. No marketplace scaffold or application database adapter is included.

A standalone Dial connectivity test is available under `scripts/dial/`, with local durable journaling and configuration checks. See `docs/DIAL_SETUP.md`. It is separate from B's application database. A signed provider ping returned HTTP 200; Number B's PING reached A; A's automatic reply reached B. Dial history reported both outbound sends delivered and corresponding inbound records. The local journal recorded one incoming command and one accepted reply attempt; the reply event was ignored by the router. Sanitized provider evidence is stored privately in `.local/dial/test-evidence.json`.

Run on Node 22.13 or newer:

```sh
npm ci
npm run typecheck:messaging
npm run test:messaging
```

Tests use fake transport and an in-memory inbox under `tests/messaging/` only. They never send an SMS or contact a database. Their deduplication checks verify the handler/adapter boundary, not production database uniqueness or crash recovery.

**Implemented modules**

| File | Responsibility |
|---|---|
| `src/lib/dial/signature.ts` | Constant-time HMAC verification over exact bytes; five-minute timestamp window; malformed signatures fail safely |
| `src/lib/dial/webhook.ts` | Framework-neutral Request/Response handler; signed envelope validation, service/participant filtering, durable-inbox boundary |
| `src/lib/dial/client.ts` | Dial SDK transport; recipient allowlist, explicit send enablement, one attempt, safe result classification |
| `src/lib/sms/intent.ts` | Pure command/listing parsing and missing-field clarification; no side effects |
| `src/lib/sms/ports.ts` | Proposed inbox/sender interfaces and extracted draft shape; no database schema |

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

1. B confirms the framework/runtime, ID/public-code formats (D/O prefixes are provisional), authenticated buyer context, and persistence interface. A does not create B's schema or migrate the database.
2. Define listing-write and draft operations, including seller opt-in, transaction boundaries, message ordering, and queued confirmation. Implement A's router against the agreed adapter.
3. Define atomic offer acceptance/reservation/order creation and request idempotency. Implement A's negotiation service, offer endpoints, and protected buyer simulator.
4. B supplies native/Darwin search and dashboard; A supplies normalized input, source-aware SMS formatting, and event provenance. Preserve the PRD's shared search response shape.
5. Two Dial numbers, the webhook signing secret, and the live inbound/reply test are configured and verified. The remaining live tests are listing creation and negotiation against B's application database. Those are required to close the marketplace PRD milestones.

No application migrations, seed data, search implementation, dashboard, payment integration, or production in-memory fallback is part of this branch's messaging modules.
