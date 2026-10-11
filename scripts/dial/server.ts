import { createServer } from "node:http";
import { chmodSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { inspectDialConfig } from "../../src/lib/dial/config.ts";
import { createDialSender } from "../../src/lib/dial/client.ts";
import { createDialWebhookHandler } from "../../src/lib/dial/webhook.ts";
import { ConnectivityJournal } from "./journal.ts";

const config = inspectDialConfig();
if (config.errors.length) {
  console.error(config.errors.join("\n"));
  process.exit(1);
}
process.umask(0o077);
const directory = resolve(".local/dial");
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const journal = new ConnectivityJournal(resolve(directory, "connectivity.sqlite"));
const handler = config.webhookReady ? createDialWebhookHandler({
  signingSecret: process.env.DIAL_WEBHOOK_SECRET!, serviceNumber: process.env.DIAL_SERVICE_NUMBER!,
  allowedParticipants: [process.env.DIAL_PARTICIPANT_NUMBER!], inbox: journal,
}) : null;
const sender = createDialSender({ apiKey: process.env.DIAL_API_KEY!, serviceNumberId: process.env.DIAL_SERVICE_NUMBER_ID!,
  allowedRecipients: [process.env.DIAL_PARTICIPANT_NUMBER!], enabled: config.sendsEnabled });

const server = createServer(async (req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ mode: "dial-connectivity-test", webhookReady: Boolean(handler) }));
    return;
  }
  if (req.url !== "/api/dial/webhook") { res.writeHead(404).end(); return; }
  if (!handler) { res.writeHead(503).end("Configure DIAL_WEBHOOK_SECRET and restart."); return; }
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    const response = await handler(new Request("http://localhost/api/dial/webhook", {
      method: req.method, headers,
      ...(req.method === "POST" ? { body: new Uint8Array(Buffer.concat(chunks)) } : {}),
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(await response.text());
    console.log(`Webhook HTTP ${response.status}`);
  } catch { res.writeHead(500).end(); }
});
server.requestTimeout = 10000;
server.headersTimeout = 10000;
let stopping = false;
let active: Promise<void> | undefined;
const timer = setInterval(() => {
  if (stopping || active || !handler || !config.sendsEnabled) return;
  active = journal.replyOnce(sender).then((sent) => {
    if (sent) console.log("Reply attempt recorded:", JSON.stringify(journal.summary()));
  }).catch(() => console.error("Journal error; inspect the local journal before retrying any sends.")).finally(() => { active = undefined; });
}, 1000);
server.on("error", () => {
  clearInterval(timer); journal.close(); console.error("Could not bind Dial test server. Check the port."); process.exitCode = 1;
});
server.listen(config.port, "127.0.0.1", () => {
  console.log(`Dial connectivity test: http://127.0.0.1:${config.port}`);
  console.log(`Webhook ${handler ? "ready" : "awaiting signing secret; restart after configuring"}; replies ${config.sendsEnabled ? "enabled for PING only" : "disabled"}.`);
  console.log("This test does not create listings or process marketplace commands.");
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  server.close(() => { void (active ?? Promise.resolve()).finally(() => journal.close()); });
});
