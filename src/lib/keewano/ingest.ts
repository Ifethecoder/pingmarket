/**
 * Keewano REST ingestion (https://api.keewano.com/event/ingress/v1/json). Server-side only.
 *
 * Enabled when `KEEWANO_API_KEY` (an SDK key: Settings → Project → API Keys) is set, and never under
 * Vitest. `track()` is fire-and-forget: analytics must never fail or slow a marketplace action.
 */
import { createHash, randomUUID } from "node:crypto";
import { KEEWANO_EVENT_TYPES, KEEWANO_EVENTS, KEEWANO_EVENTS_HASH, type KeewanoEvent } from "./catalog";

const INGEST_URL = "https://api.keewano.com/event/ingress/v1/json";
const SDK_VERSION = "pingmarket-server/1.0";

export type EntityKind = "offer" | "listing" | "search";

function apiKey(): string | null {
  return process.env.KEEWANO_API_KEY?.trim() || null;
}

export function isKeewanoIngestEnabled(): boolean {
  return apiKey() !== null && !process.env.VITEST;
}

/** RFC 4122 v5 UUID: the same name always maps to the same UUID. */
export function uuidV5(name: string, namespace = "6ba7b811-9dad-11d1-80b4-00c04fd430c8" /* NAMESPACE_URL */): string {
  const hash = createHash("sha1")
    .update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
    .update(name, "utf8")
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Keewano entity id (`installId`) for a PingMarket entity key such as `offerKey(offer)`. */
export function entityUuid(kind: EntityKind, key: string): string {
  return uuidV5(`pingmarket:${kind}:${key}`);
}

async function post(path: string, key: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${INGEST_URL}/${path}`, {
    method: "POST",
    headers: { "k-token": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    // keep the raw text for the error message
  }
  return { status: res.status, json };
}

let registration: Promise<void> | null = null;

/** Registers the catalog once per process (re-registering the same map is a no-op on Keewano's side). */
export function ensureCatalogRegistered(key: string): Promise<void> {
  registration ??= (async () => {
    const { status, json } = await post("custom", key, {
      customEventsHash: KEEWANO_EVENTS_HASH,
      eventTypes: KEEWANO_EVENT_TYPES,
    });
    if (status >= 300) throw new Error(`custom-event registration failed: HTTP ${status} ${JSON.stringify(json)}`);
  })().catch((err) => {
    registration = null; // retry on the next send
    throw err;
  });
  return registration;
}

function toWire(e: KeewanoEvent, now: number) {
  const def = KEEWANO_EVENTS[e.name];
  const data = def.type === "string" && typeof e.value === "string" ? e.value.slice(0, 256) : (e.value ?? null);
  return { eventTypeId: def.id, dataType: def.type, timestamp: e.timestamp ?? now, data };
}

/**
 * Sends one entity's events, in order, as a single batch. Each call is its own data session, so
 * concurrent sends can never be dropped as out-of-sequence. Throws on failure; see `track()`.
 */
export async function sendEvents(installId: string, events: KeewanoEvent[], key = apiKey()): Promise<number> {
  if (!key) throw new Error("KEEWANO_API_KEY is not set");
  if (events.length === 0) return 0;
  await ensureCatalogRegistered(key);
  const now = Math.floor(Date.now() / 1000);
  const { status, json } = await post("in", key, {
    dataSessionId: randomUUID(),
    batch: 1,
    customEventsHash: KEEWANO_EVENTS_HASH,
    installId,
    sdkVersion: SDK_VERSION,
    events: events.map((e) => toWire(e, now)),
  });
  if (status >= 300) throw new Error(`event batch rejected: HTTP ${status} ${JSON.stringify(json)}`);
  return typeof json === "object" && json !== null && "accepted" in json ? Number(json.accepted) : events.length;
}

/** Fire-and-forget send; a no-op when ingestion is disabled. Failures are logged, never thrown. */
export function track(kind: EntityKind, key: string, events: KeewanoEvent[]): void {
  if (!isKeewanoIngestEnabled()) return;
  sendEvents(entityUuid(kind, key), events).catch((err) => {
    console.warn(`[keewano] ${kind} ${key}: ${err instanceof Error ? err.message : String(err)}`);
  });
}
