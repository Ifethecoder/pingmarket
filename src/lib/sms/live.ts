import { and, desc, eq, or, sql } from "drizzle-orm";
import { getDb, type Db } from "../db";
import { messages } from "../db/schema";
import type { MessageDirection } from "../types";

export interface LiveMessage {
  id: string;
  body: string;
  direction: MessageDirection;
  createdAt: string;
}

/** The latest real Dial messages for the configured phone pair, in display order. */
export async function listLiveThread(
  serviceNumber: string | null,
  participantNumber: string | null,
  db?: Db,
  limit = 100,
): Promise<LiveMessage[]> {
  if (!serviceNumber || !participantNumber) return [];
  const conn = db ?? (await getDb());
  const rows = await conn
    .select({ id: messages.id, body: messages.body, direction: messages.direction, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        or(
          and(eq(messages.fromNumber, participantNumber), eq(messages.toNumber, serviceNumber)),
          and(eq(messages.fromNumber, serviceNumber), eq(messages.toNumber, participantNumber)),
        ),
        // Literal prefixes: SQL LIKE's underscore wildcard would also exclude genuine IDs like simX.
        sql`left(${messages.dialEventId}, 4) NOT IN ('sim_', 'dev_')`,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit);
  return rows.reverse().map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}
