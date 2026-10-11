import { NextResponse, connection } from "next/server";
import { getDb } from "@/lib/db";
import { marketplaces } from "@/lib/db/schema";
import { internalError } from "@/lib/http";
import type { Marketplace } from "@/lib/types";

/** GET /api/marketplaces → `{ marketplaces: Marketplace[] }` */
export async function GET() {
  // Always request-time: never prerender DB state at build (cacheComponents is on).
  await connection();
  try {
    const db = await getDb();
    const rows: Marketplace[] = await db.select().from(marketplaces).orderBy(marketplaces.id);
    return NextResponse.json({ marketplaces: rows });
  } catch (err) {
    return internalError("GET /api/marketplaces", err);
  }
}
