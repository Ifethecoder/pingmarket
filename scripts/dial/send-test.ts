import { DialClient } from "@getdial/sdk";
import { inspectDialConfig } from "../../src/lib/dial/config.ts";

async function main() {
  const config = inspectDialConfig();
  if (config.errors.length || !config.sendsEnabled || !process.env.DIAL_PARTICIPANT_NUMBER_ID) {
    console.error("Complete .env.local, set DIAL_PARTICIPANT_NUMBER_ID, and explicitly set DIAL_SEND_ENABLED=true first.");
    process.exitCode = 1; return;
  }
  const apiKey = process.env.DIAL_PARTICIPANT_API_KEY || process.env.DIAL_API_KEY!;
  const dial = new DialClient({ apiKey, userAgent: "pingmarket-dial-check/0.1.0" });
  const number = (await dial.listNumbers()).find((entry) => entry.id === process.env.DIAL_PARTICIPANT_NUMBER_ID);
  if (!number || number.number !== process.env.DIAL_PARTICIPANT_NUMBER) {
    console.error("Number B's ID/phone do not match the participant account. No SMS sent.");
    process.exitCode = 1; return;
  }
  // Explicit one-shot command. No automatic retries on success OR failure.
  const result = await dial.sendMessage({ fromNumberId: number.id, to: process.env.DIAL_SERVICE_NUMBER!, body: "PING", channel: "sms" });
  console.log(`Dial accepted the PING (${result.id}). Check the server's journal and Number B for the reply.`);
}
main().catch(() => {
  console.error("Test did not finish. The send outcome may be unknown; check Dial message history before rerunning.");
  process.exitCode = 1;
});
