import { sql } from "drizzle-orm";
import type { Db } from "./index";

/** postgres-js returns an array of rows; PGlite returns `{ rows }`. */
function firstRow<T>(result: unknown): T {
  const rows = Array.isArray(result) ? result : (result as { rows: T[] }).rows;
  return rows[0] as T;
}

async function nextval(db: Db, seq: string): Promise<number> {
  const result = await db.execute(sql`select nextval(${seq}::regclass)::int as n`);
  return Number(firstRow<{ n: number | string }>(result).n);
}

/** Mints a human listing id, e.g. `D101`. */
export async function nextListingId(db: Db): Promise<string> {
  return `D${await nextval(db, "listing_id_seq")}`;
}

/** Mints a human offer id, e.g. `O7`. */
export async function nextOfferId(db: Db): Promise<string> {
  return `O${await nextval(db, "offer_id_seq")}`;
}

/** Mints an order id, e.g. `ORD3`. */
export async function nextOrderId(db: Db): Promise<string> {
  return `ORD${await nextval(db, "order_id_seq")}`;
}

/** Opaque id for messages / agent_searches / interests, e.g. `msg_3f2a…`. */
export function newUuidId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
