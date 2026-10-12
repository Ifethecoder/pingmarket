import type { ListingDraft } from "./ports.ts";

export type SmsIntent =
  | { type: "sell"; draft: ListingDraft; missing: ("title" | "priceCents" | "location")[] }
  | { type: "search"; query: string }
  | { type: "buy" }
  | { type: "offer"; listingCode: string; priceCents: number }
  | { type: "counter"; offerCode: string; priceCents: number }
  | { type: "accept" | "decline"; offerCode: string }
  | { type: "remove" | "details"; listingCode: string }
  | { type: "edit"; listingCode: string; changes: string }
  | { type: "agent"; index: number }
  | { type: "help" | "stop" | "cancel" }
  | { type: "unrecognized" }
  | { type: "invalid"; message: string };

const invalid = (message: string): SmsIntent => ({ type: "invalid", message });
const listingCode = /^D[A-Z0-9-]{1,31}$/i;
const offerCode = /^O[A-Z0-9-]{1,31}$/i;

/** Parse decimal dollars without floating-point rounding or exponent syntax. */
export function parsePrice(text: string): number | null {
  const match = /^\$?(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match || match[1].replaceAll(",", "").length > 7) return null;
  const cents = Number(match[1].replaceAll(",", "")) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return cents > 0 && cents <= 100_000_000 ? cents : null;
}

function completedDraft(draft: ListingDraft): SmsIntent {
  if ((draft.title && draft.title.length > 120) || (draft.location && draft.location.length > 160) ||
      (draft.description && draft.description.length > 1000)) return invalid("Listing details are too long.");
  const missing = (["title", "priceCents", "location"] as const).filter((key) => !draft[key]);
  return { type: "sell", draft, missing };
}

function withLocation(draft: ListingDraft, tail: string): ListingDraft {
  // Split a comma or a sentence introducing pickup/delivery details, not place
  // names such as St. Louis. No location inferred from a sender's phone number.
  const match = /^(.*?)(?:,\s*|\.\s+(?=(?:pickup|pick-up|delivery|collection)\b))(.*)$/i.exec(tail);
  return {
    ...draft,
    ...(tail.trim() ? { location: (match ? match[1] : tail).trim().replace(/\.$/, "") } : {}),
    ...(match?.[2]?.trim() ? { description: match[2].trim() } : {}),
  };
}

function parseSell(text: string): SmsIntent {
  // SELL item, price, location[, details]. Support thousands separators in price.
  const formatted = /^(.*?),\s*(\$?\d+(?:,\d{3})*(?:\.\d+)?)(?:\s*,\s*(.*))?$/s.exec(text);
  if (formatted) {
    const priceCents = parsePrice(formatted[2]);
    if (priceCents === null) return invalid("Use a positive price with at most two decimal places.");
    return completedDraft(withLocation({ title: formatted[1].trim(), priceCents }, formatted[3] ?? ""));
  }
  // A supported natural-language form; not an unrestricted language model.
  const natural = /^(.+?)\s+for\s+(\S+)(?:\s+(?:in|near|at)\s+(.+))?$/is.exec(text);
  if (natural) {
    const priceCents = parsePrice(natural[2]);
    if (priceCents === null) return invalid("Use a positive price with at most two decimal places.");
    return completedDraft(withLocation({ title: natural[1].trim(), priceCents }, natural[3] ?? ""));
  }
  if (text.includes(",") || /\$|\bfor\b/i.test(text)) return invalid("Please use SELL item, $price, location, optional details.");
  return completedDraft(text.trim() ? { title: text.trim() } : {});
}

/** Pure parsing only: no database writes, identity assignment, or SMS sends. */
export function parseSms(body: string): SmsIntent {
  const text = body.trim().replaceAll("’", "'");
  if (!text || text.length > 2000) return invalid("Send a message between 1 and 2000 characters.");
  const [verb, ...args] = text.split(/\s+/);
  const command = verb.toUpperCase();
  if (["HELP", "STOP", "CANCEL"].includes(command)) {
    return args.length ? invalid(`Use ${command} by itself.`) : { type: command.toLowerCase() as "help" | "stop" | "cancel" };
  }
  if (command === "SELL") return parseSell(text.slice(4).trim());
  if (["OFFER", "COUNTER"].includes(command)) {
    const priceCents = args.length === 2 ? parsePrice(args[1]) : null;
    const validCode = (command === "OFFER" ? listingCode : offerCode).test(args[0] ?? "");
    if (!validCode || priceCents === null) return invalid(`Use ${command} ${command === "OFFER" ? "D42" : "O7"} 100.`);
    return command === "OFFER"
      ? { type: "offer", listingCode: args[0].toUpperCase(), priceCents }
      : { type: "counter", offerCode: args[0].toUpperCase(), priceCents };
  }
  if (["ACCEPT", "DECLINE"].includes(command)) {
    if (args.length !== 1 || !offerCode.test(args[0])) return invalid(`Use ${command} O7.`);
    return { type: command.toLowerCase() as "accept" | "decline", offerCode: args[0].toUpperCase() };
  }
  if (["REMOVE", "DETAILS"].includes(command)) {
    if (args.length !== 1 || !listingCode.test(args[0])) return invalid(`Use ${command} D42.`);
    return { type: command.toLowerCase() as "remove" | "details", listingCode: args[0].toUpperCase() };
  }
  if (command === "EDIT") {
    if (args.length < 2 || !listingCode.test(args[0])) return invalid("Use EDIT D42 followed by the changed details.");
    // This is a request, not a validated mutation. The router must validate fields
    // and ownership before applying any edits.
    return { type: "edit", listingCode: args[0].toUpperCase(), changes: args.slice(1).join(" ") };
  }
  if (command === "AGENT") {
    if (args.length !== 1 || !/^[1-9]\d?$/.test(args[0])) return invalid("Use AGENT followed by a result number.");
    return { type: "agent", index: Number(args[0]) };
  }
  if (command === "SEARCH") return args.length ? { type: "search", query: text.slice(6).trim() } : invalid("What are you looking for?");
  if (command === "BUY") return args.length ? invalid("Use BUY by itself.") : { type: "buy" };
  const naturalSell = /^(?:i(?:'d| would) like to sell|i(?:'m| am) selling|selling)\s+(?:my\s+)?(.+)$/is.exec(text);
  if (naturalSell) return parseSell(naturalSell[1]);
  if (/^(?:looking for|i(?:'m| am) looking for|i need|find me)\b/i.test(text)) return { type: "search", query: text };
  return { type: "unrecognized" };
}

/** Apply a response to the next missing field; caller owns draft persistence/expiry. */
export function clarifyListing(draft: ListingDraft, body: string): SmsIntent {
  const explicit = parseSms(body);
  if (explicit.type !== "unrecognized" && !(explicit.type === "invalid" && /^\$?\d/.test(body.trim()))) return explicit;
  const text = body.trim();
  if (!text || text.length > 2000) return invalid("Please supply the missing detail or CANCEL.");
  if (!draft.title) return completedDraft({ ...draft, title: text });
  if (draft.priceCents === undefined) {
    const priceCents = parsePrice(text);
    return priceCents === null ? invalid("Reply with a positive price, for example $120.50.") : completedDraft({ ...draft, priceCents });
  }
  if (!draft.location) return completedDraft(withLocation(draft, text));
  return invalid("This draft is already complete. Send SELL to start another listing.");
}
