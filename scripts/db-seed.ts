/** Seeds demo data (idempotent) into the external Postgres at DATABASE_URL. Usage: npm run db:seed */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/lib/db/schema";
import { seed } from "../src/lib/db/seed";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. The embedded PGlite DB seeds itself on first request; this script is only for external Postgres.");
    process.exit(1);
  }
  const client = postgres(url, { max: 1, prepare: false });
  try {
    await seed(drizzle(client, { schema }));
    console.log("Seed complete.");
  } finally {
    await client.end();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
