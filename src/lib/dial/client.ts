import { DialClient, type SendMessageParams } from "@getdial/sdk";
import type { SmsSender } from "../sms/ports.ts";
import { isE164 } from "./webhook.ts";

type Transport = {
  sendMessage(params: SendMessageParams): Promise<{ id: string }>;
};
type Config = {
  apiKey: string;
  serviceNumberId: string;
  allowedRecipients: readonly string[];
  enabled: boolean;
};

/** Transport only. The application must persist an attempt before invoking it. */
export function createDialSender(config: Config, transport?: Transport): SmsSender {
  if (!config.apiKey.trim() || !config.serviceNumberId.trim() ||
      config.allowedRecipients.length === 0 || config.allowedRecipients.some((to) => !isE164(to))) {
    throw new Error("Invalid Dial sender configuration");
  }
  const allowed = new Set(config.allowedRecipients);
  const dial = transport ?? new DialClient({ apiKey: config.apiKey, userAgent: "pingmarket/0.1.0" });
  return {
    async send(to, body) {
      if (!config.enabled) return { status: "blocked", reason: "disabled" };
      if (!allowed.has(to)) return { status: "blocked", reason: "recipient_not_allowed" };
      if (!body.trim() || body.length > 1600) return { status: "blocked", reason: "invalid_message" };
      try {
        const result = await dial.sendMessage({ to, fromNumberId: config.serviceNumberId, body, channel: "sms" });
        if (!result.id) return { status: "unknown" };
        return { status: "accepted", providerMessageId: result.id };
      } catch {
        // Even a thrown error may follow a successful send. Never retry here or
        // leak the SDK's error string, which can contain provider response data.
        return { status: "unknown" };
      }
    },
  };
}
