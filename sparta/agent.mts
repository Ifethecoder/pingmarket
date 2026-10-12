/**
 * PingMarket SMS checkout agent, run inside a Sparta Worlds Digital Shop twin.
 *
 * Turns a buyer's text ("desk under $150 in Berkeley") into an unpaid Stripe draft invoice using the
 * same deterministic parser as production search (src/lib/search/query.ts). The runner supplies
 * WORLDS_BASE_URL / WORLDS_API_KEY / WORLDS_TASK_JSON; no real Stripe credentials are used.
 *
 *   npx --no-install worlds starters run --project ./sparta --mission sms-desk-berkeley
 */
import { parseBuyerQuery } from "../src/lib/search/query.ts";

interface Task {
  templateId: string;
  mission: { id: string; title: string; prompt: string; policy: string[] };
}
interface Product { id: string; name: string; active?: boolean }
interface Price {
  id: string;
  product: string;
  unit_amount: number;
  currency: string;
  active: boolean;
  recurring: unknown;
}

const task = JSON.parse(process.env.WORLDS_TASK_JSON || "null") as Task | null;
const baseUrl = process.env.WORLDS_BASE_URL;
const apiKey = process.env.WORLDS_API_KEY;
if (!task || !baseUrl || !apiKey) {
  throw new Error("Run via `worlds starters run --project ./sparta`; WORLDS_* variables are required");
}

const customer = task.mission.prompt.match(/\b(cus_[A-Za-z0-9_]+)/)?.[1];
const sms = task.mission.prompt.match(/texted: "([^"]+)"/)?.[1];
if (!customer || !sms) throw new Error(`Mission ${task.mission.id} has no buyer id or SMS text`);

function encode(value: Record<string, unknown>, prefix = "", out = new URLSearchParams()) {
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (child !== null && typeof child === "object") encode(child as Record<string, unknown>, name, out);
    else out.append(name, String(child));
  }
  return out;
}

/** Bounded retry on 429/500 with a stable idempotency key, so an injected interruption cannot double-write. */
async function stripe<T>(method: "GET" | "POST", path: string, params: Record<string, unknown> = {}, key?: string) {
  const url = new URL(path, baseUrl);
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
  const init: RequestInit = { method, headers };
  if (method === "GET") url.search = encode(params).toString();
  else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    headers["idempotency-key"] = `pingmarket-${task!.mission.id}-${key ?? path}`;
    init.body = encode(params).toString();
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const body = await res.text();
    if (res.ok) return JSON.parse(body) as T;
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      continue;
    }
    throw new Error(`${method} ${path}: HTTP ${res.status} ${body}`);
  }
}

const query = parseBuyerQuery(sms);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const [{ data: products }, { data: prices }] = await Promise.all([
  stripe<{ data: Product[] }>("GET", "/v1/products", { limit: 100 }),
  stripe<{ data: Price[] }>("GET", "/v1/prices", { limit: 100 }),
]);
const buyable = new Map(
  prices
    .filter((p) => p.active && !p.recurring && p.currency === "usd")
    .map((p) => [p.product, p] as const),
);

// Greedy cover: best word overlap first (then cheapest), consuming matched words so
// "office chair and a floor lamp" yields two listings and "standing desk" never falls back to "oak desk".
let remaining = new Set(query.tokens);
const picked: { product: Product; price: Price }[] = [];
for (;;) {
  const best = products
    .filter((p) => p.active !== false && buyable.has(p.id) && !picked.some((x) => x.product.id === p.id))
    .map((p) => ({ product: p, price: buyable.get(p.id)!, hits: words(p.name).filter((w) => remaining.has(w)) }))
    .filter((c) => c.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length || a.price.unit_amount - b.price.unit_amount)[0];
  if (!best) break;
  picked.push(best);
  remaining = new Set([...remaining].filter((w) => !best.hits.includes(w)));
}

const total = picked.reduce((sum, x) => sum + x.price.unit_amount, 0);
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

if (picked.length === 0 || (query.maxPriceCents !== null && total > query.maxPriceCents)) {
  const what = picked.map((x) => `${x.product.name} (${dollars(x.price.unit_amount)})`).join(", ") || "nothing matching";
  console.log(`SMS reply: Sorry, ${what} is over your ${dollars(query.maxPriceCents ?? 0)} budget. Reply with a new max to try again.`);
  process.exit(0);
}

for (const [i, { price }] of picked.entries()) {
  await stripe("POST", "/v1/invoiceitems", { customer, price: price.id, quantity: 1 }, `item-${i}`);
}
const invoice = await stripe<{ id: string; total: number }>("POST", "/v1/invoices", { customer, currency: "usd" }, "invoice");

console.log(
  `SMS reply: Found ${picked.map((x) => x.product.name).join(" + ")} for ${dollars(total)}. ` +
    `Draft ${invoice.id} saved; reply PAY for a checkout link.`,
);
