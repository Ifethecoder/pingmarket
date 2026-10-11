/**
 * Test helper: an isolated in-memory PGlite database, migrated and seeded.
 * Never touches ./.pglite. Use with the optional `db` parameter on services.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MIGRATIONS_FOLDER, type Db } from "./index";
import * as schema from "./schema";
import { seed } from "./seed";

export async function createTestDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await seed(db);
  return db;
}
