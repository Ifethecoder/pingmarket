/**
 * Database connection (dual driver).
 * - DATABASE_URL set   -> postgres-js (Supabase pooler compatible; run `npm run db:migrate && npm run db:seed`).
 * - DATABASE_URL unset -> embedded PGlite in ./.pglite, auto-migrated from ./drizzle and auto-seeded on first open.
 * The instance is memoized on globalThis so Next dev hot reloads never open a second PGlite on the same data dir.
 */
import { readFileSync } from "node:fs";
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
  __pingmarketMigrated?: number;
};

/** Number of migrations in drizzle/meta/_journal.json (0 if unreadable). */
function migrationCount(): number {
  try {
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"));
    return journal.entries?.length ?? 0;
  } catch {
    return 0;
  }
}

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
  globalForDb.__pingmarketMigrated = migrationCount();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await seed(db);
  return db;
}

export function getDb(): Promise<Db> {
  // In dev the memoized PGlite outlives hot reloads, so apply migrations generated after it was opened.
  if (
    globalForDb.__pingmarketDb &&
    isEmbeddedDb() &&
    process.env.NODE_ENV !== "production" &&
    migrationCount() !== globalForDb.__pingmarketMigrated
  ) {
    const opened = globalForDb.__pingmarketDb;
    globalForDb.__pingmarketMigrated = migrationCount();
    globalForDb.__pingmarketDb = opened.then(async (db) => {
      const { migrate } = await import("drizzle-orm/pglite/migrator");
      try {
        await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder: MIGRATIONS_FOLDER });
      } catch (err) {
        // Keep the open connection and retry on the next call.
        globalForDb.__pingmarketMigrated = undefined;
        globalForDb.__pingmarketDb = opened;
        throw err;
      }
      return db;
    });
  }
  if (!globalForDb.__pingmarketDb) {
    globalForDb.__pingmarketDb = openDb().catch((err) => {
      globalForDb.__pingmarketDb = undefined;
      throw err;
    });
  }
  return globalForDb.__pingmarketDb;
}
