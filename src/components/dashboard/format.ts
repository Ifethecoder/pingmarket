import type { Marketplace, MarketplaceId } from "@/lib/types";

const moneyFormatters = new Map<string, Intl.NumberFormat>();

/** 120000 -> "$1,200.00" */
export function formatCents(cents: number, currency = "USD"): string {
  let fmt = moneyFormatters.get(currency);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat("en-US", { style: "currency", currency });
    } catch {
      fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
    }
    moneyFormatters.set(currency, fmt);
  }
  return fmt.format(cents / 100);
}

const absoluteFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "medium",
});

export function formatAbsolute(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : absoluteFormatter.format(date);
}

/** "now", "12s ago", "4m ago", "3h ago", "2d ago" */
export function formatRelative(value: string | number, now: number): string {
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return String(value);
  const s = Math.round((now - t) / 1000);
  if (s < 3) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function marketplaceName(id: MarketplaceId | string, marketplaces: Marketplace[]): string {
  const found = marketplaces.find((m) => m.id === id);
  if (found) return found.name;
  return `${id.charAt(0).toUpperCase()}${id.slice(1)} Market`;
}
