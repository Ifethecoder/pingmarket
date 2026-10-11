import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { verifyDialSignature } from "../../src/lib/dial/signature.ts";
import { createDialWebhookHandler } from "../../src/lib/dial/webhook.ts";
import type { ReceivedSms, SmsInbox } from "../../src/lib/sms/ports.ts";

const secret = "test-signing-secret-not-a-real-credential";
const now = Date.parse("2026-10-11T12:00:00Z");
const service = "+14155550100";
const participant = "+14155550101";
function signature(raw: Uint8Array, timestamp = now / 1000) {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest("hex")}`;
}
function event() {
  return { id: "evt_1", object: "event", version: 1, createdAt: new Date(now).toISOString(), type: "message.received",
    data: { messageId: "msg_1", from: participant, to: service, body: "SELL oak desk, $120, Berkeley", source: "external" } };
}
function request(payload = event(), headers: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/dial/webhook", { method: "POST", body, headers: {
    "x-dial-signature": signature(Buffer.from(body)), "x-dial-event-id": payload.id, "x-dial-event-type": payload.type, ...headers,
  } });
}
// Deliberately test-only. Production requires B's durable, atomic inbox adapter.
function fixture() {
  const messages: ReceivedSms[] = [];
  const inbox: SmsInbox = { async receive(message) {
    if (messages.some((row) => row.eventId === message.eventId || row.messageId === message.messageId)) return "duplicate";
    messages.push(message);
    return "stored";
  } };
  const handle = createDialWebhookHandler({ signingSecret: secret, serviceNumber: service, allowedParticipants: [participant], inbox, now: () => now });
  return { messages, handle };
}

test("signature covers exact bytes, including whitespace and Unicode", () => {
  const bytes = Buffer.from('{ "body": "café desk" }');
  const signed = signature(bytes);
  assert.equal(verifyDialSignature(bytes, signed, secret, now), true);
  assert.equal(verifyDialSignature(Buffer.from('{"body":"café desk"}'), signed, secret, now), false);
  assert.equal(verifyDialSignature(bytes, signed, "wrong-secret", now), false);
});
test("malformed signatures fail without throwing", () => {
  for (const header of [null, "", "t=oops,v1=aa", "t=1,v1=z".repeat(32), `t=${now / 1000},v1=aa`, `${signature(Buffer.from("{}"))},t=1`]) {
    assert.equal(verifyDialSignature(Buffer.from("{}"), header, secret, now), false);
  }
});
test("old and future signatures outside five minutes are rejected", () => {
  const bytes = Buffer.from("{}");
  for (const seconds of [-301, -300, 300, 301]) assert.equal(verifyDialSignature(bytes, signature(bytes, now / 1000 + seconds), secret, now), false);
  assert.equal(verifyDialSignature(bytes, signature(bytes, now / 1000 - 299), secret, now), true);
});
test("verified SMS is normalized and passed to inbox; same event is not re-enqueued", async () => {
  const { messages, handle } = fixture();
  assert.deepEqual(await (await handle(request())).json(), { status: "stored" });
  assert.deepEqual(await (await handle(request())).json(), { status: "duplicate" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].source, "dial_sms");
  assert.equal(messages[0].providerSource, "external");
  assert.equal(messages[0].body, event().data.body);
});
test("different envelope for the same message relies on message-level inbox deduplication", async () => {
  const { messages, handle } = fixture();
  await handle(request());
  assert.deepEqual(await (await handle(request({ ...event(), id: "evt_2" }))).json(), { status: "duplicate" });
  assert.equal(messages.length, 1);
});
test("invalid signature or mismatched event headers never reach storage", async () => {
  const { messages, handle } = fixture();
  assert.equal((await handle(request(event(), { "x-dial-signature": "bad" }))).status, 401);
  assert.equal((await handle(request(event(), { "x-dial-event-id": "different" }))).status, 400);
  assert.equal((await handle(request(event(), { "x-dial-event-type": "call.ended" }))).status, 400);
  assert.equal(messages.length, 0);
});
test("pings, replies at Number B, and non-allowlisted senders are ignored", async () => {
  const { messages, handle } = fixture();
  const base = event();
  for (const payload of [
    { ...base, type: "webhook.ping" },
    { ...base, data: { ...base.data, from: service, to: participant } },
    { ...base, data: { ...base.data, from: "+14155550199" } },
  ]) assert.deepEqual(await (await handle(request(payload))).json(), { status: "ignored" });
  assert.equal(messages.length, 0);
});
test("invalid signed message and unknown event version are rejected", async () => {
  const { messages, handle } = fixture();
  const base = event();
  assert.equal((await handle(request({ ...base, data: { ...base.data, from: "not-a-number" } }))).status, 400);
  assert.equal((await handle(request({ ...base, version: 2 }))).status, 400);
  assert.equal(messages.length, 0);
});
test("signed invalid JSON and oversized bodies fail safely", async () => {
  const { handle } = fixture();
  const body = "not json";
  assert.equal((await handle(new Request("https://example.test", { method: "POST", body, headers: { "x-dial-signature": signature(Buffer.from(body)) } }))).status, 400);
  assert.equal((await handle(new Request("https://example.test", { method: "POST", body: "x".repeat(65537) }))).status, 413);
});
test("storage failure returns retryable status without leaking error contents", async () => {
  const handle = createDialWebhookHandler({ signingSecret: secret, serviceNumber: service, allowedParticipants: [participant], now: () => now,
    inbox: { async receive() { throw new Error("secret database connection details"); } },
  });
  const result = await handle(request());
  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { error: "inbox_unavailable" });
});
test("acknowledgement waits for inbox persistence", async () => {
  let persist!: (value: "stored") => void;
  const saved = new Promise<"stored">((resolve) => { persist = resolve; });
  const handle = createDialWebhookHandler({ signingSecret: secret, serviceNumber: service, allowedParticipants: [participant], now: () => now,
    inbox: { receive: () => saved },
  });
  let acknowledged = false;
  const pending = handle(request()).then((result) => { acknowledged = true; return result; });
  await setImmediate();
  assert.equal(acknowledged, false);
  persist("stored");
  assert.equal((await pending).status, 200);
});
