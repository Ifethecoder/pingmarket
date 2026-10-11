/**
 * Database connection (dual driver).
 * - DATABASE_URL set   -> postgres-js (Supabase pooler compatible; run `npm run db:migrate && npm run db:seed`).
 * - DATABASE_URL unset -> embedded PGlite in ./.pglite, auto-migrated from ./drizzle and auto-seeded on first open.
 * The instance is memoized on globalThis so Next dev hot reloads never open a second PGlite on the same data dir.
 */
import path from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { seed } from "./seed";

export type Schema = typeof schema;
/** Common supertype of the postgres-js and PGlite drizzle databases. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

const globalForDb = globalThis as typeof globalThis & {
  __pingmarketDb?: Promise<Db>;
};

export function isEmbeddedDb(): boolean {
  return !process.env.DATABASE_URL;
}

async function openDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const postgres = (await import("postgres")).default;
    return drizzle(postgres(url, { max: 5, prepare: false }), { schema });
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite(path.join(process.cwd(), ".pglite"));
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await seed(db);
  return db;
}

export function getDb(): Promise<Db> {
  if (!globalForDb.__pingmarketDb) {
    globalForDb.__pingmarketDb = openDb().catch((err) => {
      globalForDb.__pingmarketDb = undefined;
      throw err;
    });
  }
  return globalForDb.__pingmarketDb;
}
