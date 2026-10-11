import { defineConfig } from "drizzle-kit";

// Used only for `npm run db:generate` (SQL migration generation from src/lib/db/schema.ts).
// Runtime migration is done by src/lib/db/index.ts (PGlite) or scripts/db-migrate.ts (Postgres).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/pingmarket",
  },
});
