import assert from "node:assert/strict";
import { test } from "node:test";
import { createDialSender } from "../../src/lib/dial/client.ts";

const to = "+14155550101";
const config = { apiKey: "test-key", serviceNumberId: "pn_test", allowedRecipients: [to], enabled: true };

test("sender makes one SMS request and reports acceptance, not delivery", async () => {
  const requests: unknown[] = [];
  const sender = createDialSender(config, { async sendMessage(input) { requests.push(input); return { id: "msg_test" }; } });
  assert.deepEqual(await sender.send(to, "Listed #D42"), { status: "accepted", providerMessageId: "msg_test" });
  assert.deepEqual(requests, [{ to, fromNumberId: "pn_test", body: "Listed #D42", channel: "sms" }]);
});
test("disabled, unapproved, empty, and oversized sends never contact Dial", async () => {
  const transport = { async sendMessage() { assert.fail("must not call provider"); } };
  const disabled = createDialSender({ ...config, enabled: false }, transport);
  assert.deepEqual(await disabled.send(to, "hello"), { status: "blocked", reason: "disabled" });
  const sender = createDialSender(config, transport);
  assert.deepEqual(await sender.send("+14155550199", "hello"), { status: "blocked", reason: "recipient_not_allowed" });
  for (const text of [" ", "x".repeat(1601)]) assert.deepEqual(await sender.send(to, text), { status: "blocked", reason: "invalid_message" });
});
test("ambiguous failure does not retry or leak provider response data", async () => {
  let attempts = 0;
  const sender = createDialSender(config, { async sendMessage() { attempts++; throw new Error("sensitive provider response"); } });
  assert.deepEqual(await sender.send(to, "hello"), { status: "unknown" });
  assert.equal(attempts, 1);
});
