import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConnectivityJournal } from "../../scripts/dial/journal.ts";
import { inspectDialConfig } from "../../src/lib/dial/config.ts";
import type { ReceivedSms } from "../../src/lib/sms/ports.ts";

const message: ReceivedSms = { eventId: "evt1", messageId: "msg1", from: "+14155550101", to: "+14155550100",
  body: "PING", occurredAt: new Date().toISOString(), source: "dial_sms", providerSource: "internal" };

test("journal survives reopening and deduplicates both provider IDs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pingmarket-dial-"));
  let journal = new ConnectivityJournal(join(directory, "test.sqlite"));
  try {
    assert.equal(await journal.receive(message), "stored");
    journal.close();
    journal = new ConnectivityJournal(join(directory, "test.sqlite"));
    assert.equal(await journal.receive(message), "duplicate");
    assert.equal(await journal.receive({ ...message, eventId: "evt2" }), "duplicate");
    let sends = 0;
    const sender = { async send(to: string, body: string) {
      sends++; assert.equal(to, message.from); assert.match(body, /received your PING/);
      return { status: "accepted" as const, providerMessageId: "reply1" };
    } };
    assert.equal(await journal.replyOnce(sender), true);
    assert.equal(await journal.replyOnce(sender), false);
    assert.equal(sends, 1);
    assert.deepEqual(journal.summary().map((row) => ({ ...row })), [{ status: "accepted", count: 1 }]);
  } finally { journal.close(); rmSync(directory, { recursive: true }); }
});
test("non-PING messages are recorded without creating replies", async () => {
  const journal = new ConnectivityJournal(":memory:");
  try {
    await journal.receive({ ...message, body: "SELL desk, $120, Berkeley" });
    assert.equal(await journal.replyOnce({ async send() { assert.fail("must not send"); } }), false);
    assert.equal(journal.summary()[0].status, "ignored");
  } finally { journal.close(); }
});
test("ambiguous send outcomes are never automatically retried", async () => {
  const journal = new ConnectivityJournal(":memory:");
  try {
    await journal.receive(message);
    let attempts = 0;
    const sender = { async send() { attempts++; return { status: "unknown" as const }; } };
    await journal.replyOnce(sender);
    await journal.replyOnce(sender);
    assert.equal(attempts, 1);
    assert.equal(journal.summary()[0].status, "unknown");
  } finally { journal.close(); }
});
test("a persisted in-flight claim is not picked up by another connection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pingmarket-dial-"));
  const path = join(directory, "test.sqlite");
  const first = new ConnectivityJournal(path);
  const second = new ConnectivityJournal(path);
  let complete!: (value: { status: "unknown" }) => void;
  try {
    await first.receive(message);
    const sending = first.replyOnce({ send: () => new Promise((resolve) => { complete = resolve; }) }, 1000);
    assert.equal(await second.replyOnce({ async send() { assert.fail("must not send again"); } }, 400_000), false);
    assert.equal(second.summary()[0].status, "unknown");
    complete({ status: "unknown" });
    await sending;
  } finally { first.close(); second.close(); rmSync(directory, { recursive: true }); }
});
test("configuration reports only field names, never secret values", () => {
  const empty = inspectDialConfig({});
  assert.ok(empty.errors.length > 0);
  const config = inspectDialConfig({ DIAL_API_KEY: "secret-value", DIAL_SERVICE_NUMBER: message.to, DIAL_SERVICE_NUMBER_ID: "pn1",
    DIAL_PARTICIPANT_NUMBER: message.from, DIAL_SEND_ENABLED: "false" });
  assert.deepEqual(config.errors, []);
  assert.equal(config.webhookReady, false);
  assert.equal(config.sendsEnabled, false);
  assert.equal(JSON.stringify(config).includes("secret-value"), false);
});
