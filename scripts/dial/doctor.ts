import { inspectDialConfig } from "../../src/lib/dial/config.ts";

async function main() {
  const listOnly = process.argv.includes("--numbers");
  const report = inspectDialConfig();
  if (!listOnly) {
    for (const error of report.errors) console.log(`Missing/invalid: ${error}`);
    console.log(`Webhook secret: ${report.webhookReady ? "configured" : "not configured yet"}`);
    console.log(`SMS sending: ${report.sendsEnabled ? "enabled" : "disabled"}`);
    if (report.errors.length) { process.exitCode = 1; return; }
  }
  const apiKey = process.argv.includes("--participant")
    ? process.env.DIAL_PARTICIPANT_API_KEY || process.env.DIAL_API_KEY
    : process.env.DIAL_API_KEY;
  if (!apiKey?.trim()) { console.error("Add the account API key to .env.local first."); process.exitCode = 1; return; }
  if (!listOnly && !process.argv.includes("--online")) {
    console.log("Local configuration is valid. Add --online to verify Number A against Dial (read-only).");
    return;
  }
  const response = await fetch("https://api.getdial.ai/api/v1/numbers", {
    headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "pingmarket-dial-check/0.1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Dial lookup returned HTTP ${response.status}`);
  const data = await response.json() as { numbers?: { id: string; number: string }[] };
  if (!Array.isArray(data.numbers)) throw new Error("Dial returned an unexpected numbers response");
  if (listOnly) {
    console.table(data.numbers.map(({ id, number }) => ({ id, number })));
    console.log("Read-only account lookup. No numbers purchased and no SMS sent.");
    return;
  }
  const service = data.numbers.find((number) => number.id === process.env.DIAL_SERVICE_NUMBER_ID);
  if (!service) throw new Error("Configured service number ID is not on this Dial account");
  const phone = service.number;
  if (phone !== process.env.DIAL_SERVICE_NUMBER) throw new Error("Service number ID does not match the configured phone number");
  console.log("Dial API key works and Number A matches this account. No message was sent.");
}
main().catch((error: unknown) => {
  // Do not print raw provider bodies or transport errors containing credentials.
  const safe = error instanceof Error && /^(Dial lookup returned HTTP \d+|Dial returned an unexpected numbers response|Configured service number ID is not on this Dial account|Service number ID does not match the configured phone number)$/.test(error.message);
  console.error(safe ? (error as Error).message : "Dial connection check failed. Check configuration and network access.");
  process.exitCode = 1;
});
