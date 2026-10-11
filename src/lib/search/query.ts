/**
 * Deterministic buyer-query parsing (no LLM): search tokens, an optional max price, an optional location.
 * Used by native search and to pass budget/location context to Darwin.
 */

export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "for", "in", "near", "under", "below", "less", "than", "also", "and", "or",
  "with", "i", "im", "looking", "want", "need", "interested", "something", "like", "max", "up",
  "to", "dollars", "usd", "of", "my", "me", "please",
]);

export interface ParsedBuyerQuery {
  tokens: string[];
  maxPriceCents: number | null;
  location: string | null;
}

/** Known demo locations (lowercase alias -> canonical display name). */
const KNOWN_LOCATIONS: ReadonlyArray<[string, string]> = [
  ["san francisco", "San Francisco"],
  ["berkeley", "Berkeley"],
  ["oakland", "Oakland"],
  ["sf", "San Francisco"],
];

const AMOUNT = String.raw`(\d[\d,]*(?:\.\d{1,2})?)`;
/** The amount must not run into other word chars, so "24x36" or "150k" never parse as a price. */
const AMOUNT_END = String.raw`(?!\w|\.\d)`;

/** Ordered by specificity: cue before the amount, cue after the amount, bare "$N" last. */
const PRICE_PATTERNS: RegExp[] = [
  new RegExp(
    String.raw`(?:\b(?:under|below|less than|no more than|at most|up to|max(?:imum)?|budget(?:\s+(?:of|is))?)|<=|<)\s*\$?\s*${AMOUNT}${AMOUNT_END}`,
    "i",
  ),
  new RegExp(
    String.raw`(?<![\w.$])\$?\s*${AMOUNT}${AMOUNT_END}\s*(?:dollars|usd)?\s*(?:or less|max(?:imum)?|tops|budget)\b`,
    "i",
  ),
  new RegExp(String.raw`\$\s*${AMOUNT}${AMOUNT_END}`),
];

function toCents(amount: string): number | null {
  const n = Number.parseFloat(amount.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

export function parseMaxPriceCents(query: string): number | null {
  for (const re of PRICE_PATTERNS) {
    const m = re.exec(query);
    if (m) {
      const cents = toCents(m[1]);
      if (cents !== null) return cents;
    }
  }
  return null;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseLocation(query: string): string | null {
  // 1) "in/near/around <known location>" (case-insensitive)
  for (const [alias, canonical] of KNOWN_LOCATIONS) {
    const re = new RegExp(String.raw`\b(?:in|near|around)\s+${escapeRegExp(alias)}\b`, "i");
    if (re.test(query)) return canonical;
  }
  // 2) "in/near/around <Capitalized Word(s)>"
  const cap = /\b(?:[Ii]n|[Nn]ear|[Aa]round)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\b/.exec(query);
  if (cap && !STOPWORDS.has(cap[1].toLowerCase())) return titleCase(cap[1]);
  // 3) a bare known location anywhere ("$100 Berkeley")
  for (const [alias, canonical] of KNOWN_LOCATIONS) {
    if (new RegExp(String.raw`\b${escapeRegExp(alias)}\b`, "i").test(query)) return canonical;
  }
  return null;
}

function singularize(token: string): string {
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function parseBuyerQuery(query: string): ParsedBuyerQuery {
  const maxPriceCents = parseMaxPriceCents(query);
  const location = parseLocation(query);

  let text = query.toLowerCase().replace(/['’]/g, "");
  if (location) {
    // Location words are a filter, not search text.
    const aliases = KNOWN_LOCATIONS.filter(([, c]) => c === location).map(([a]) => a);
    for (const word of new Set([location.toLowerCase(), ...aliases])) {
      text = text.replace(new RegExp(String.raw`\b${escapeRegExp(word)}\b`, "g"), " ");
    }
  }

  const tokens: string[] = [];
  for (const raw of text.split(/[^a-z0-9]+/)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    if (/^\d+(?:k)?$/.test(raw)) continue; // pure numbers / prices
    const token = singularize(raw);
    if (STOPWORDS.has(token) || tokens.includes(token)) continue;
    tokens.push(token);
  }
  return { tokens, maxPriceCents, location };
}
