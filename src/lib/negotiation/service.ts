/** Developer A proposal: shared persistence and IDs require Developer B review. */
export type Offer = {
  code: string;
  listingCode: string;
  buyerId: string;
  sellerId: string;
  priceCents: number;
  lastActorId: string;
  status: "open" | "countered" | "accepted" | "declined" | "closed";
  expiresAt: number;
  version: number;
  orderId?: string;
};
export type NegotiationCommand =
  | { type: "offer"; listingCode: string; priceCents: number }
  | { type: "counter"; offerCode: string; priceCents: number; expectedVersion: number }
  | { type: "accept" | "decline"; offerCode: string; expectedVersion: number };
export type NegotiationResult =
  | { status: "ok"; offer: Offer }
  | { status: "rejected"; reason: "invalid" | "not_found" | "forbidden" | "unavailable" | "expired" | "stale" | "closed" };

export interface NegotiationTransaction {
  /** Authenticated server context, never an ID supplied by an SMS/browser body. */
  actorId: string;
  lockListing(code: string): Promise<{ sellerId: string; status: "available" | "reserved" | "sold" | "removed" } | null>;
  /** Lock its listing FIRST, then offer, using the same locks as seller edits.
   * Return the listing state under that lock; never use an unlocked snapshot. */
  lockOffer(code: string): Promise<{ offer: Offer; listingStatus: "available" | "reserved" | "sold" | "removed" } | null>;
  createOffer(fields: Omit<Offer, "code">): Promise<Offer>;
  saveOffer(offer: Offer): Promise<void>;
  /** Under listing lock: reserve listing, create ONE pending-payment order for
   * this offer/price/participants, close all competing actionable offers. */
  reserveAndCreateOrder(offer: Offer): Promise<{ orderId: string }>;
  /** Persist notification intent/activity, never call an external transport.
   * Adapter chooses SMS or dashboard based on trusted participant provenance. */
  notify(participantId: string, body: string): Promise<void>;
}

export interface NegotiationStore {
  /** Resolve authenticated actor from integration context. Deduplicate requestId
   * scoped to actor AND source, bind it to the exact command, reject reuse with
   * changed input. Persist result, domain writes and notifications atomically.
   * Roll back on throw. Serialize all listing/offer operations with seller edits.
   * Callback can be retried: no external side effects. */
  execute(requestId: string, command: NegotiationCommand,
    work: (tx: NegotiationTransaction) => Promise<NegotiationResult>): Promise<NegotiationResult>;
}

const reject = (reason: Extract<NegotiationResult, { status: "rejected" }>["reason"]): NegotiationResult => ({ status: "rejected", reason });
const validPrice = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 100_000_000;
const money = (value: number) => `$${(value / 100).toFixed(2)}`;

export function createNegotiationService(store: NegotiationStore, options: { offerLifetimeMs: number; now?: () => number }) {
  if (!Number.isSafeInteger(options.offerLifetimeMs) || options.offerLifetimeMs <= 0) throw new Error("Invalid offer lifetime");
  const now = options.now ?? Date.now;
  return {
    execute(requestId: string, command: NegotiationCommand): Promise<NegotiationResult> {
      if (!requestId.trim() || requestId.length > 200 || !["offer", "counter", "accept", "decline"].includes(command.type)) return Promise.resolve(reject("invalid"));
      if (!(command.type === "offer" ? /^D[A-Z0-9-]{1,31}$/.test(command.listingCode) : /^O[A-Z0-9-]{1,31}$/.test(command.offerCode)) ||
          ((command.type === "offer" || command.type === "counter") && !validPrice(command.priceCents)) ||
          (command.type !== "offer" && (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1))) return Promise.resolve(reject("invalid"));
      return store.execute(requestId, command, async tx => {
        const time = now();
        if (!Number.isSafeInteger(time) || !Number.isSafeInteger(time + options.offerLifetimeMs)) throw new Error("Invalid clock");
        if (command.type === "offer") {
          const listing = await tx.lockListing(command.listingCode);
          if (!listing) return reject("not_found");
          if (listing.sellerId === tx.actorId) return reject("forbidden");
          if (listing.status !== "available") return reject("unavailable");
          const offer = await tx.createOffer({ listingCode: command.listingCode, buyerId: tx.actorId,
            sellerId: listing.sellerId, priceCents: command.priceCents, lastActorId: tx.actorId,
            status: "open", expiresAt: time + options.offerLifetimeMs, version: 1 });
          if (!/^O[A-Z0-9-]{1,31}$/.test(offer.code)) throw new Error("Invalid offer code from adapter");
          await tx.notify(offer.sellerId, `Offer ${offer.code}: ${money(offer.priceCents)} for ${offer.listingCode}. Reply ACCEPT ${offer.code}, COUNTER ${offer.code} <price>, or DECLINE ${offer.code}.`);
          return { status: "ok", offer };
        }
        const locked = await tx.lockOffer(command.offerCode);
        if (!locked) return reject("not_found");
        const offer = locked.offer;
        const recipient = offer.lastActorId === offer.buyerId ? offer.sellerId : offer.buyerId;
        if (tx.actorId !== recipient) return reject("forbidden");
        // Authorized repeated acceptance returns the committed order, even after
        // expiry or a stale client version; it never creates another order.
        if (command.type === "accept" && offer.status === "accepted") {
          if (!offer.orderId) throw new Error("Accepted offer missing order");
          return { status: "ok", offer };
        }
        if (offer.status !== "open" && offer.status !== "countered") return reject("closed");
        if (offer.expiresAt <= time) return reject("expired");
        if (command.expectedVersion !== offer.version) return reject("stale");
        if (locked.listingStatus !== "available") return reject("unavailable");
        let updated: Offer = { ...offer, version: offer.version + 1 };
        if (command.type === "counter") {
          if (tx.actorId !== offer.sellerId || offer.status !== "open") return reject("forbidden");
          updated = { ...updated, priceCents: command.priceCents, lastActorId: tx.actorId, status: "countered" };
          await tx.saveOffer(updated);
          await tx.notify(offer.buyerId, `Counter ${offer.code}: ${money(updated.priceCents)} for ${offer.listingCode}. Accept or decline this offer.`);
        } else if (command.type === "accept") {
          const { orderId } = await tx.reserveAndCreateOrder(offer);
          if (!orderId) throw new Error("Missing order ID");
          updated = { ...updated, status: "accepted", orderId };
          await tx.saveOffer(updated);
          await tx.notify(offer.lastActorId, `Accepted ${offer.code} for ${money(offer.priceCents)}. Order ${orderId} is pending payment.`);
        } else {
          updated = { ...updated, status: "declined" };
          await tx.saveOffer(updated);
          await tx.notify(offer.lastActorId, `Offer ${offer.code} was declined.`);
        }
        return { status: "ok", offer: updated };
      });
    },
  };
}
