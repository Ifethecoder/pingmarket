/**
 * Process-wide Dial configuration for the Next app: the webhook route and outbound SMS.
 * Read once from env (restart after editing `.env.local`) and memoized on globalThis so Next dev hot
 * reloads keep one sender. Never exposes secrets to callers that render responses.
 */
import type { SmsSender } from "../sms/ports.ts";
import { createDialSender } from "./client.ts";
import { inspectDialConfig } from "./config.ts";

export interface DialRuntime {
  /** Every Dial env var needed to receive and send is present and valid. */
  configured: boolean;
  errors: string[];
  /** PingMarket's Dial number (Number A). */
  serviceNumber: string | null;
  /** The real buyer's phone (Number B). The only number we ever text. */
  participantNumber: string | null;
  webhookSecret: string | null;
  webhookReady: boolean;
  sendsEnabled: boolean;
  /** Null when not configured. When sends are disabled it still exists but blocks every send. */
  sender: SmsSender | null;
}

export function createDialRuntime(env: Record<string, string | undefined> = process.env): DialRuntime {
  const { errors, webhookReady, sendsEnabled } = inspectDialConfig(env);
  const configured = errors.length === 0;
  const participantNumber = env.DIAL_PARTICIPANT_NUMBER?.trim() || null;
  return {
    configured,
    errors,
    serviceNumber: env.DIAL_SERVICE_NUMBER?.trim() || null,
    participantNumber,
    webhookSecret: env.DIAL_WEBHOOK_SECRET?.trim() || null,
    webhookReady,
    sendsEnabled,
    sender: configured
      ? createDialSender({
          apiKey: env.DIAL_API_KEY!.trim(),
          serviceNumberId: env.DIAL_SERVICE_NUMBER_ID!.trim(),
          allowedRecipients: [participantNumber!],
          enabled: sendsEnabled,
        })
      : null,
  };
}

const globalForDial = globalThis as typeof globalThis & { __pingmarketDialRuntime?: DialRuntime };

export function getDialRuntime(): DialRuntime {
  return (globalForDial.__pingmarketDialRuntime ??= createDialRuntime());
}

/** Test hook: install a runtime (e.g. with a fake sender), or `null` to re-read env on next use. */
export function setDialRuntimeForTests(runtime: DialRuntime | null): void {
  globalForDial.__pingmarketDialRuntime = runtime ?? undefined;
}
