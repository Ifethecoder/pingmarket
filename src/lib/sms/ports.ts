/** Developer A integration proposals; not an agreed database schema. */
export type ReceivedSms = {
  eventId: string;
  messageId: string;
  from: string;
  to: string;
  body: string;
  occurredAt: string;
  source: "dial_sms";
  providerSource: "external" | "internal" | "unknown";
};

export interface SmsInbox {
  /**
   * Persist before resolving. Atomically deduplicate eventId AND messageId and
   * make new messages available for recoverable processing. A duplicate must
   * not overwrite original content or enqueue work again. Throw on failure.
   * An in-memory implementation is appropriate only in tests.
   */
  receive(message: ReceivedSms): Promise<"stored" | "duplicate">;
}

export type SmsSendResult =
  | { status: "accepted"; providerMessageId: string }
  | { status: "blocked"; reason: "disabled" | "recipient_not_allowed" | "invalid_message" }
  | { status: "unknown" };

export interface SmsSender {
  /** One attempt only. Accepted means provider acceptance, not delivery. */
  send(to: string, body: string): Promise<SmsSendResult>;
}

export type ListingDraft = {
  title?: string;
  priceCents?: number;
  location?: string;
  description?: string;
};
// Identity, visibility/consent, and marketplace are supplied by trusted
// application context. They are deliberately absent from extracted drafts.
