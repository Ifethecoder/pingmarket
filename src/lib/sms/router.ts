import { clarifyListing, parseSms } from "./intent.ts";
import type { ListingDraft, ReceivedSms } from "./ports.ts";

/** Proposed application adapter contract, pending Developer B review. */
export type SellerContext = {
  participantId: string;
  marketplaceId: "furniture" | "creative";
  crossMarketConsentId?: string;
};

export type SellerConversation = {
  draft?: { fields: ListingDraft; expiresAt: number };
  lastOccurredAt?: number;
};

export type NewSellerListing = Required<ListingDraft> & {
  sellerId: string;
  marketplaceId: SellerContext["marketplaceId"];
  currency: "USD";
  status: "available";
  visibility: "marketplace_only" | "cross_market";
  crossMarketConsentId?: string;
};

export interface SellerTransaction {
  /** Resolve from the stored SMS phone/service pair, never from message text. */
  actor: SellerContext;
  conversation: SellerConversation;
  createListing(listing: NewSellerListing): Promise<{ code: string }>;
  saveConversation(conversation: SellerConversation): Promise<void>;
  /** Persist intent only; do not call Dial inside this transaction. */
  enqueueReply(body: string): Promise<void>;
}

export interface SellerMessageStore {
  /**
   * Load an immutable, previously received SMS by event ID. Serialize processing
   * per sender/service conversation; deduplicate BOTH event and message IDs.
   * Resolve identity/marketplace/recorded consent server-side. Commit callback
   * writes, outbound intent, and event completion atomically; roll back on throw.
   * Callback may be retried by a database transaction: no external side effects.
   * Return duplicate without invoking callback for an already processed message.
   */
  process(eventId: string, work: (message: ReceivedSms, tx: SellerTransaction) => Promise<void>): Promise<"processed" | "duplicate">;
}

const draftLifetimeMs = 30 * 60 * 1000;
const help = "To list: SELL oak desk, $120, Berkeley, pickup only. Reply CANCEL to discard an unfinished listing. HELP shows these instructions.";
const prompts = {
  title: "What are you selling? Reply with a title, or CANCEL.",
  priceCents: "What is the price? Reply with a positive amount, for example $120, or CANCEL.",
  location: "Where is it located? Reply with a location, or CANCEL.",
};

/** Seller slice only. No live storage, transport, search, or negotiation fallback. */
export function createSellerRouter(store: SellerMessageStore, now: () => number = Date.now) {
  return {
    process(eventId: string) {
      const processingTime = now();
      if (!Number.isFinite(processingTime)) throw new Error("Invalid processing time");
      return store.process(eventId, async (message, tx) => {
        const occurredAt = Date.parse(message.occurredAt);
        if (!Number.isFinite(occurredAt)) throw new Error("Invalid stored message time");
        // A late clarification must not modify a newer draft. Equal timestamps
        // use the adapter's serialized receipt order; provider time is not a queue.
        if (tx.conversation.lastOccurredAt !== undefined && occurredAt < tx.conversation.lastOccurredAt) {
          await tx.enqueueReply("This message arrived out of order. Please resend your latest command.");
          return;
        }
        const savedDraft = tx.conversation.draft;
        const expired = savedDraft !== undefined && savedDraft.expiresAt <= processingTime;
        const draft = expired ? undefined : savedDraft;
        const conversation: SellerConversation = { lastOccurredAt: occurredAt, ...(draft ? { draft } : {}) };
        const intent = draft ? clarifyListing(draft.fields, message.body) : parseSms(message.body);
        let reply: string;

        switch (intent.type) {
          case "sell": {
            // Revalidate extracted fields at the business boundary, including
            // persisted drafts. Identity and sharing are never extracted fields.
            const fields = intent.draft;
            if ((fields.title !== undefined && (!fields.title.trim() || fields.title.length > 120)) ||
                (fields.location !== undefined && (!fields.location.trim() || fields.location.length > 160)) ||
                (fields.description !== undefined && fields.description.length > 1000) ||
                (fields.priceCents !== undefined && (!Number.isSafeInteger(fields.priceCents) || fields.priceCents <= 0 || fields.priceCents > 100_000_000))) {
              reply = "Invalid listing details. Please send SELL item, $price, location, optional details.";
              break;
            }
            const missing = (["title", "priceCents", "location"] as const).find(key => fields[key] === undefined);
            if (missing) {
              const isNewSell = parseSms(message.body).type === "sell";
              conversation.draft = { fields, expiresAt: isNewSell ? processingTime + draftLifetimeMs : draft!.expiresAt };
              reply = prompts[missing];
              break;
            }
            const consent = tx.actor.crossMarketConsentId;
            const listing = await tx.createListing({
              title: fields.title!, priceCents: fields.priceCents!, location: fields.location!,
              description: fields.description ?? "", sellerId: tx.actor.participantId,
              marketplaceId: tx.actor.marketplaceId, currency: "USD", status: "available",
              visibility: consent ? "cross_market" : "marketplace_only",
              ...(consent ? { crossMarketConsentId: consent } : {}),
            });
            if (!/^D[A-Z0-9-]{1,31}$/.test(listing.code)) throw new Error("Invalid listing code from adapter");
            delete conversation.draft;
            reply = `Listed ${listing.code}: ${fields.title} for $${(fields.priceCents! / 100).toFixed(2)} in ${fields.location}.`;
            break;
          }
          case "cancel":
            delete conversation.draft;
            reply = savedDraft ? "Your unfinished listing was cancelled." : "You have no unfinished listing to cancel.";
            break;
          case "help": reply = help; break;
          case "invalid": reply = intent.message; break;
          case "unrecognized":
            reply = expired ? "Your listing draft expired. Send SELL to start again." : help;
            break;
          default:
            // Explicit commands must never be swallowed as clarification text.
            // STOP needs the shared consent/provider integration before live use.
            reply = "This command is not connected in the seller flow yet. Send HELP for available commands.";
        }
        await tx.saveConversation(conversation);
        await tx.enqueueReply(reply);
      });
    },
  };
}
