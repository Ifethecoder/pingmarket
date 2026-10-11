/**
 * Deterministic buyer-query parsing (no LLM): search tokens, an optional max price, an optional location.
 * Used by native search and to pass budget/location context to Darwin.
 */

export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "for", "in", "near", "under", "below", "less", "than", "also", "and", "or",
  "with", "i", "im", "looking", "want", "need", "interested", "something", "like", "max", "up",
  "to", "dollars", "usd", "of", "my", "me", "please", "market", "at", "from", "any", "anything",
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

const NUM = String.raw`\d[\d,]*(?:\.\d{1,2})?`;
/** The amount must not run into other word chars, so "24x36" or "150k" never parse as a price. */
const AMOUNT_END = String.raw`(?!\w|\.\d)`;
const AMOUNT = String.raw`(?<amount>${NUM})${AMOUNT_END}`;
/** Optional range tail ("150-200", "$150-$200"); the upper bound becomes the max price. */
const RANGE_UPPER = String.raw`(?:\s*[-–]\s*\$?\s*(?<upper>${NUM})${AMOUNT_END})?`;

/** Ordered by specificity: cue before the amount, cue after the amount, bare "$N" last. */
const PRICE_PATTERNS: RegExp[] = [
  new RegExp(
    String.raw`(?:\b(?:under|below|less than|no more than|at most|up to|max(?:imum)?|budget(?:\s+(?:of|is))?)|<=|<)\s*(?<dollar>\$)?\s*${AMOUNT}${RANGE_UPPER}`,
    "gi",
  ),
  new RegExp(
    String.raw`(?<![\w.$])\$?\s*${AMOUNT}\s*(?:dollars|usd)?\s*(?:or less|max(?:imum)?|tops|budget)\b`,
    "gi",
  ),
  new RegExp(String.raw`(?<dollar>\$)\s*${AMOUNT}${RANGE_UPPER}`, "g"),
];

/**
 * A bare number (no "$") followed by one of these is a measurement or count, not a price:
 * "under 2 feet", "up to 6 people". "in" only counts as inches when it is not followed by a word
 * ("under 30 in" / "under 30 in wide"), so "under 150 in Berkeley" stays a price.
 */
const UNIT_AFTER =
  /^\s*(?:feet|ft|inch(?:es)?|cm|m|kg|lbs?|x|wide|tall|long|days|weeks|hours|people|in\b(?=\s*(?:$|[^\sA-Za-z]|wide|tall|long|deep|high)))\b/i;

function toCents(amount: string): number | null {
  const n = Number.parseFloat(amount.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

export function parseMaxPriceCents(query: string): number | null {
  for (const re of PRICE_PATTERNS) {
    for (const m of query.matchAll(re)) {
      const groups = m.groups ?? {};
      const rest = query.slice((m.index ?? 0) + m[0].length);
      if (!groups.dollar && UNIT_AFTER.test(rest)) continue;
      const cents = toCents(groups.upper ?? groups.amount);
      if (cents !== null) return cents;
    }
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Only KNOWN_LOCATIONS are recognized, so "desk in Excellent condition" never yields a location.
 * A prepositioned mention ("in/near/around Berkeley") wins over a bare one ("$100 Berkeley").
 */
export function parseLocation(query: string): string | null {
  for (const [alias, canonical] of KNOWN_LOCATIONS) {
    const re = new RegExp(String.raw`\b(?:in|near|around)\s+${escapeRegExp(alias)}\b`, "i");
    if (re.test(query)) return canonical;
  }
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
