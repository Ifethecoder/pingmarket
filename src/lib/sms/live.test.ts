import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db";
import { messages } from "../db/schema";
import { createTestDb } from "../db/testing";
import { listLiveThread } from "./live";

const serviceNumber = "+15550001000";
const participantNumber = "+15550002000";
let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await db.delete(messages);
});

function message(id: string, seconds: number, overrides: Partial<typeof messages.$inferInsert> = {}) {
  return {
    id,
    dialEventId: `dial_${id}`,
    fromNumber: participantNumber,
    toNumber: serviceNumber,
    body: `Message ${id}`,
    direction: "inbound" as const,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)),
    ...overrides,
  };
}

describe("listLiveThread", () => {
  it("includes both directions, excluding simulator, development and unrelated messages", async () => {
    await db.insert(messages).values([
      message("inbound", 1),
      message("outbound", 2, { fromNumber: serviceNumber, toNumber: participantNumber, direction: "outbound" }),
      message("sim", 3, { dialEventId: "sim_inbound" }),
      message("dev", 4, { dialEventId: "dev_inbound" }),
      message("other-participant", 5, { fromNumber: "+15550003000" }),
      message("other-service", 6, { toNumber: "+15550004000" }),
      message("literal-prefix", 7, { dialEventId: "simXreal" }),
    ]);
    const thread = await listLiveThread(serviceNumber, participantNumber, db);
    expect(thread.map((row) => row.id)).toEqual(["inbound", "outbound", "literal-prefix"]);
    expect(thread[0]).toEqual({
      id: "inbound",
      body: "Message inbound",
      direction: "inbound",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    expect(JSON.stringify(thread)).not.toContain(participantNumber);
  });

  it("returns the latest 100 messages in ascending display order", async () => {
    await db.insert(messages).values(Array.from({ length: 105 }, (_, i) => message(`message-${i}`, i)));
    const thread = await listLiveThread(serviceNumber, participantNumber, db);
    expect(thread).toHaveLength(100);
    expect(thread[0].id).toBe("message-5");
    expect(thread.at(-1)?.id).toBe("message-104");
    expect(thread.map((row) => row.createdAt)).toEqual(thread.map((row) => row.createdAt).sort());
  });

  it("does not open a database or include a thread without both configured numbers", async () => {
    expect(await listLiveThread(null, participantNumber)).toEqual([]);
    expect(await listLiveThread(serviceNumber, null)).toEqual([]);
  });
});
