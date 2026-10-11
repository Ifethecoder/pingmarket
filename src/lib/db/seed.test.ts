import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_FOLDER, type Db } from "./index";
import * as schema from "./schema";
import { users } from "./schema";
import { seed, SELLER_DEMO_PHONE, SMS_BUYER_ID } from "./seed";

async function migratedDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

async function phoneOf(db: Db, id: string): Promise<string | null | undefined> {
  const [row] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, id));
  return row?.phone;
}

afterEach(() => vi.unstubAllEnvs());

// Each test boots its own PGlite (like the suite hooks, which get 30s in vitest.config.mts).

describe("seed phone identities", () => {
  it("maps the Dial participant phone to the SMS buyer on a fresh database", async () => {
    vi.stubEnv("DIAL_PARTICIPANT_NUMBER", "+14155550123");
    const db = await migratedDb();
    await seed(db);
    expect(await phoneOf(db, SMS_BUYER_ID)).toBe("+14155550123");
    expect(await phoneOf(db, "u_seller_demo")).toBe(SELLER_DEMO_PHONE);
    const [buyer] = await db.select().from(users).where(eq(users.id, SMS_BUYER_ID));
    expect(buyer).toMatchObject({ role: "buyer", consentStatus: "opted_in" });
  }, 30_000);

  it("reconciles an old database where the participant phone belonged to u_seller_demo, then follows env changes", async () => {
    const db = await migratedDb();
    // Pre-change seed: the real participant phone was the demo seller's.
    await db.insert(users).values({ id: "u_seller_demo", phone: "+14155550123", role: "seller", consentStatus: "opted_in" });

    vi.stubEnv("DIAL_PARTICIPANT_NUMBER", "+14155550123");
    await seed(db);
    expect(await phoneOf(db, "u_seller_demo")).toBe(SELLER_DEMO_PHONE);
    expect(await phoneOf(db, SMS_BUYER_ID)).toBe("+14155550123");

    vi.stubEnv("DIAL_PARTICIPANT_NUMBER", "+14155550999");
    await seed(db);
    await seed(db);
    expect(await phoneOf(db, SMS_BUYER_ID)).toBe("+14155550999");
    expect(await phoneOf(db, "u_seller_demo")).toBe(SELLER_DEMO_PHONE);
    expect(await phoneOf(db, "u_seller_2")).toBe("+15550000003");
    expect(await phoneOf(db, "u_web_buyer")).toBeNull();
  }, 30_000);

  it("frees the fake seller phone from another user and still creates u_sms_buyer when its phone is taken", async () => {
    const db = await migratedDb();
    await db.insert(users).values([
      { id: "u_squatter", phone: SELLER_DEMO_PHONE, role: "buyer", consentStatus: "unknown" },
      { id: "u_other", phone: "+14155550777", role: "buyer", consentStatus: "unknown" },
    ]);
    vi.stubEnv("DIAL_PARTICIPANT_NUMBER", "+14155550777");
    await seed(db);
    expect(await phoneOf(db, "u_squatter")).toBeNull();
    expect(await phoneOf(db, "u_seller_demo")).toBe(SELLER_DEMO_PHONE);
    expect(await phoneOf(db, "u_other")).toBe("+14155550777");
    const [buyer] = await db.select().from(users).where(eq(users.id, SMS_BUYER_ID));
    expect(buyer).toMatchObject({ phone: null, role: "buyer" });

    // Once the phone is free, the next boot gives it to u_sms_buyer.
    await db.update(users).set({ phone: null }).where(eq(users.id, "u_other"));
    await seed(db);
    expect(await phoneOf(db, SMS_BUYER_ID)).toBe("+14155550777");
  }, 30_000);
});
