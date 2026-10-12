/** Pure SMS text helpers shared by every notification module (no I/O, no imports). */

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

/** Minor units -> money; zero-decimal currencies (JPY, KRW, …) are not divided by 100. */
export function money(cents: number, currency = "USD"): string {
  try {
    const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() });
    return fmt.format(cents / 10 ** (fmt.resolvedOptions().maximumFractionDigits ?? 2));
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}
