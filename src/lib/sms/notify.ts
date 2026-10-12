/**
 * Offer notifications: tells the other side when an offer is made or moved, from any channel
 * (dashboard, /sim handset, real Dial buyer). Recipients come from `./deliver.ts`: the real SMS buyer
 * over Dial, or a /sim handset as a simulated row. Each side always gets the same wording.
 */
import { getDb, type Db } from "../db";
import { getListing } from "../listings/service";
import { getOrCreateOrderForOffer } from "../orders/service";
import { isStripeConfigured, startCheckout } from "../payments/stripe";
import type { Listing, Message, Offer } from "../types";
import { buyerRecipient, deliver, sellerRecipient } from "./deliver";
import { describeError } from "./outbound";
import { fitSms, MAX_SMS_CHARS, money, truncate } from "./text";

export { fitSms, MAX_SMS_CHARS, money, truncate };

export type OfferChange = "countered" | "accepted" | "declined";

// Buyer-facing

export function counterText(offer: Offer, title: string | null): string {
  const what = title ? ` (${truncate(title, 60)})` : "";
  return fitSms(`Counter ${offer.id}: ${money(offer.proposedPriceCents)} for ${offer.listingId}${what}. Reply ACCEPT ${offer.id} or DECLINE ${offer.id}.`);
}

export function acceptedText(offer: Offer, orderId: string, checkoutUrl: string | null): string {
  const base = `Accepted ${offer.id} at ${money(offer.proposedPriceCents)} for ${offer.listingId}. Order ${orderId} is pending payment.`;
  return checkoutUrl ? fitSms(`${base} Pay here:`, checkoutUrl) : fitSms(`${base} Pay on the PingMarket dashboard.`);
}

export function declinedText(offer: Offer): string {
  return fitSms(`Offer ${offer.id} on ${offer.listingId} was declined.`);
}

// Seller-facing

export function newOfferText(offer: Offer, listing: Listing): string {
  return fitSms(
    `New offer ${offer.id} on ${offer.listingId} (${truncate(listing.title, 60)}): ${money(offer.proposedPriceCents)}, asking ${money(listing.priceCents, listing.currency)}. Reply ACCEPT ${offer.id}, COUNTER ${offer.id} <price>, or DECLINE ${offer.id}.`,
  );
}

export function buyerAcceptedText(offer: Offer, orderId: string): string {
  return fitSms(
    `The buyer accepted your counter ${offer.id}: ${money(offer.proposedPriceCents)} for ${offer.listingId}. Order ${orderId} is pending payment; we'll text you when they pay.`,
  );
}

export function buyerDeclinedText(offer: Offer): string {
  return fitSms(`The buyer declined your counter ${offer.id} on ${offer.listingId}. ${offer.listingId} is still listed.`);
}

/** Seller's own confirmation after moving an offer. */
export function sellerMovedText(offer: Offer, orderId?: string): string {
  const order = orderId ? ` Order ${orderId} is pending payment; we'll text you when the buyer pays.` : "";
  return fitSms(`Offer ${offer.id} is now ${offer.status} at ${money(offer.proposedPriceCents)}.${order}`);
}

/**
 * Hosted Stripe test Checkout URL for an order, or null when Stripe or the public app origin
 * (`APP_URL`, else `NEXT_PUBLIC_APP_URL`) is not configured, or Checkout fails. Never throws.
 */
export async function checkoutLinkForOrder(orderId: string, db?: Db): Promise<string | null> {
  const appUrl = process.env.APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!isStripeConfigured() || !appUrl) return null;
  try {
    const { url } = await startCheckout(orderId, { origin: new URL(appUrl).origin, db });
    return url;
  } catch (err) {
    console.warn(`[sms] no checkout link for order ${orderId}: ${describeError(err)}`);
    return null;
  }
}

/**
 * Texts the buyer of `offer` about a seller's counter / accept / decline (the real SMS buyer over Dial,
 * or the /sim buyer handset). Returns the stored row, if any.
 */
export async function notifyOfferChange(
  offer: Offer,
  change: OfferChange,
  extra: { orderId?: string; checkoutUrl?: string | null } = {},
  db?: Db,
): Promise<Message | null> {
  const conn = db ?? (await getDb());
  const to = await buyerRecipient(offer, conn);
  if (!to) return null;

  let body: string;
  if (change === "countered") {
    const listing = await getListing(offer.listingId, conn);
    body = counterText(offer, listing?.title ?? null);
  } else if (change === "accepted") {
    const orderId = extra.orderId ?? (await getOrCreateOrderForOffer(offer.id, conn)).order.id;
    const checkoutUrl = extra.checkoutUrl !== undefined ? extra.checkoutUrl : await checkoutLinkForOrder(orderId, conn);
    body = acceptedText(offer, orderId, checkoutUrl);
  } else {
    body = declinedText(offer);
  }
  return deliver(to, body, conn);
}

/** Texts the seller (the /sim seller handset only) that the buyer answered their counter. */
export async function notifySellerOfBuyerMove(
  offer: Offer,
  change: "accepted" | "declined",
  extra: { orderId?: string } = {},
  db?: Db,
): Promise<Message | null> {
  const conn = db ?? (await getDb());
  const to = await sellerRecipient(offer, conn);
  if (!to) return null;
  if (change === "declined") return deliver(to, buyerDeclinedText(offer), conn);
  const orderId = extra.orderId ?? (await getOrCreateOrderForOffer(offer.id, conn)).order.id;
  return deliver(to, buyerAcceptedText(offer, orderId), conn);
}

/** Texts the seller (the /sim seller handset only) about a new offer on their listing. */
export async function notifyNewOffer(offer: Offer, db?: Db): Promise<Message | null> {
  const conn = db ?? (await getDb());
  const to = await sellerRecipient(offer, conn);
  if (!to) return null;
  const listing = await getListing(offer.listingId, conn);
  return listing ? deliver(to, newOfferText(offer, listing), conn) : null;
}

/**
 * Notifies after a committed transition: the counterpart of `actorId` (unless `counterpart: false`, when
 * the caller already texted them), plus the buyers of competing offers an accept declined.
 * Best effort: a failed text is logged, never surfaced.
 */
export async function notifyTransition(
  {
    offer,
    actorId,
    declined,
    orderId,
    counterpart = true,
  }: { offer: Offer; actorId: string; declined: Offer[]; orderId?: string; counterpart?: boolean },
  db?: Db,
): Promise<void> {
  const conn = db ?? (await getDb());
  const attempt = async (what: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (err) {
      console.error(`[sms] ${what} notification failed: ${describeError(err)}`);
    }
  };
  if (counterpart && actorId === offer.sellerId && offer.status !== "open") {
    await attempt(`buyer of ${offer.id}`, () => notifyOfferChange(offer, offer.status as OfferChange, { orderId }, conn));
  } else if (counterpart && actorId === offer.buyerId && (offer.status === "accepted" || offer.status === "declined")) {
    await attempt(`seller of ${offer.id}`, () => notifySellerOfBuyerMove(offer, offer.status as "accepted" | "declined", { orderId }, conn));
  }
  for (const other of declined) {
    await attempt(`buyer of ${other.id}`, () => notifyOfferChange(other, "declined", {}, conn));
  }
}
