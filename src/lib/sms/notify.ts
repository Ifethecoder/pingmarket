/**
 * Texts the real SMS buyer when a seller moves one of their offers (dashboard or /sim seller handset).
 * Only offers with `source: "sms"` have a phone to text; everything else is a no-op.
 */
import { eq } from "drizzle-orm";
import { getDb, type Db } from "../db";
import { users } from "../db/schema";
import { getListing } from "../listings/service";
import { getOrCreateOrderForOffer } from "../orders/service";
import { isStripeConfigured, startCheckout } from "../payments/stripe";
import type { Message, Offer } from "../types";
import { describeError, sendServiceSms } from "./outbound";

export type OfferChange = "countered" | "accepted" | "declined";

/** Soft cap per text so a reply stays a few SMS segments. */
export const MAX_SMS_CHARS = 480;

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Caps `text` at MAX_SMS_CHARS; a trailing `url` is always kept whole. */
export function fitSms(text: string, url?: string | null): string {
  if (!url) return truncate(text, MAX_SMS_CHARS);
  return `${truncate(text, Math.max(80, MAX_SMS_CHARS - url.length - 1))} ${url}`;
}

export function money(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

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

/** Texts the SMS buyer of `offer` about a seller's counter / accept / decline. Returns the stored row, if any. */
export async function notifyOfferChange(
  offer: Offer,
  change: OfferChange,
  extra: { orderId?: string; checkoutUrl?: string | null } = {},
  db?: Db,
): Promise<Message | null> {
  if (offer.source !== "sms") return null;
  const conn = db ?? (await getDb());
  const [buyer] = await conn
    .select({ phone: users.phone, consent: users.consentStatus })
    .from(users)
    .where(eq(users.id, offer.buyerId))
    .limit(1);
  if (!buyer?.phone || buyer.consent === "opted_out") return null;

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
  const { message } = await sendServiceSms({ to: buyer.phone, body }, conn);
  return message;
}
