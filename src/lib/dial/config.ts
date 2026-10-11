import { isE164 } from "./webhook.ts";

export function inspectDialConfig(env: NodeJS.ProcessEnv = process.env) {
  const errors: string[] = [];
  for (const name of ["DIAL_API_KEY", "DIAL_SERVICE_NUMBER_ID"]) {
    if (!env[name]?.trim()) errors.push(`${name} is missing`);
  }
  for (const name of ["DIAL_SERVICE_NUMBER", "DIAL_PARTICIPANT_NUMBER"]) {
    if (!isE164(env[name] ?? "")) errors.push(`${name} must be an E.164 phone number`);
  }
  if (env.DIAL_SERVICE_NUMBER && env.DIAL_SERVICE_NUMBER === env.DIAL_PARTICIPANT_NUMBER) {
    errors.push("Service and participant numbers must differ");
  }
  if (env.DIAL_SEND_ENABLED !== "true" && env.DIAL_SEND_ENABLED !== "false") errors.push("DIAL_SEND_ENABLED must be true or false");
  const port = Number(env.DIAL_TEST_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) errors.push("DIAL_TEST_PORT must be an integer from 1024 to 65535");
  return { errors, port, webhookReady: Boolean(env.DIAL_WEBHOOK_SECRET?.trim()), sendsEnabled: env.DIAL_SEND_ENABLED === "true" };
}
