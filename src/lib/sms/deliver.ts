/**
 * Who hears about a transaction, and the payment / payout texts.
 *
 * Buyer side: an `sms` offer's buyer is the real phone (texted over Dial, honoring STOP); the /sim buyer
 * handset (`u_web_buyer`) gets the same text as a simulated row. Seller side: only the /sim seller
 * handset (`u_seller_2`) has a phone; other sellers work from the dashboard.
 * Deliberately free of `../payments` imports so the payment code can call it.
 */
import { eq } from "drizzle-orm";
import { getDb, type Db } from "../db";
import { listings, offers, orders, users } from "../db/schema";
import { toOrder } from "../orders/service";
import type { Message, Offer, Order } from "../types";
import { describeError, sendServiceSms } from "./outbound";
import { recordSimText, simHandsetOfUser } from "./sim-handsets";
import { fitSms, money, truncate } from "./text";

export interface Recipient {
  channel: "dial" | "sim";
  number: string;
}

/** The buyer's phone for `offer`, or null (no phone, opted out, or a dashboard-only buyer). */
export async function buyerRecipient(offer: Pick<Offer, "buyerId" | "source">, db: Db): Promise<Recipient | null> {
  if (offer.source === "sms") {
    const [buyer] = await db
      .select({ phone: users.phone, consent: users.consentStatus })
      .from(users)
      .where(eq(users.id, offer.buyerId))
      .limit(1);
    if (!buyer?.phone || buyer.consent === "opted_out") return null;
    return { channel: "dial", number: buyer.phone };
  }
  const handset = await simHandsetOfUser(offer.buyerId, db);
  return handset ? { channel: "sim", number: handset.number } : null;
}

/** The seller's phone: only the /sim seller handset has one. */
export async function sellerRecipient(offer: Pick<Offer, "sellerId">, db: Db): Promise<Recipient | null> {
  const handset = await simHandsetOfUser(offer.sellerId, db);
  return handset ? { channel: "sim", number: handset.number } : null;
}

export async function deliver(to: Recipient, body: string, db: Db): Promise<Message> {
  if (to.channel === "sim") return recordSimText({ handsetNumber: to.number, body, direction: "outbound" }, db);
  return (await sendServiceSms({ to: to.number, body }, db)).message;
}

// ---------------------------------------------------------------------------
// Payment and payout

function item(listingId: string, title: string | null): string {
  return title ? `${listingId} (${truncate(title, 60)})` : listingId;
}

function payoutClause(order: Order): string {
  switch (order.payoutStatus) {
    case "paid": {
      const amount = money(order.payoutAmountCents ?? 0, order.payoutCurrency ?? "USD");
      const fee = order.platformFeeCents ? ` after a ${money(order.platformFeeCents, order.payoutCurrency ?? "USD")} fee` : "";
      return `Your payout of ${amount}${fee} was sent to your Stripe test account.`;
    }
    case "not_configured":
      return "Your payout is on hold until PingMarket finishes Stripe Connect setup.";
    case "failed":
      return "Your payout didn't go through yet; PingMarket will retry it.";
    case "not_started":
      return "Your payout is pending.";
  }
}

export function paidBuyerText(order: Order, listingId: string, title: string | null): string {
  return fitSms(
    `Payment received: ${money(order.amountCents)} for ${item(listingId, title)}. Order ${order.id} is confirmed and the seller has been told.`,
  );
}

export function paidSellerText(order: Order, listingId: string, title: string | null): string {
  return fitSms(`Sold! The buyer paid ${money(order.amountCents)} for ${item(listingId, title)}, order ${order.id}. ${payoutClause(order)}`);
}

export function payoutSentText(order: Order, listingId: string): string {
  return fitSms(`Payout for order ${order.id} (${listingId}): ${payoutClause(order)}`);
}

async function loadOrder(orderId: string, db: Db) {
  const [row] = await db
    .select({ order: orders, offer: offers, title: listings.title })
    .from(orders)
    .innerJoin(offers, eq(orders.offerId, offers.id))
    .leftJoin(listings, eq(offers.listingId, listings.id))
    .where(eq(orders.id, orderId))
    .limit(1);
  return row ? { order: toOrder(row.order), offer: row.offer, title: row.title } : null;
}

/**
 * Texts both sides that an order was just paid (call once, when the payment is first recorded and the
 * payout attempt has run). Best effort: never throws, the payment is already committed.
 */
export async function notifyOrderPaid(orderId: string, db?: Db): Promise<void> {
  try {
    const conn = db ?? (await getDb());
    const row = await loadOrder(orderId, conn);
    if (!row) return;
    const { order, offer, title } = row;
    const buyer = await buyerRecipient(offer, conn);
    if (buyer) await deliver(buyer, paidBuyerText(order, offer.listingId, title), conn);
    const seller = await sellerRecipient(offer, conn);
    if (seller) await deliver(seller, paidSellerText(order, offer.listingId, title), conn);
  } catch (err) {
    console.error(`[sms] payment notification for order ${orderId} failed: ${describeError(err)}`);
  }
}

/** Texts the seller that a retried payout went through. Best effort: never throws. */
export async function notifyPayoutSent(orderId: string, db?: Db): Promise<void> {
  try {
    const conn = db ?? (await getDb());
    const row = await loadOrder(orderId, conn);
    if (!row) return;
    const seller = await sellerRecipient(row.offer, conn);
    if (seller) await deliver(seller, payoutSentText(row.order, row.offer.listingId), conn);
  } catch (err) {
    console.error(`[sms] payout notification for order ${orderId} failed: ${describeError(err)}`);
  }
}
