import { config } from "dotenv";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { capacityRules, orders, showrooms, staffUsers } from "../src/db/schema";
import { DEFAULT_SETTINGS } from "../src/lib/settings";

config({ path: process.env.ENV_FILE ?? ".env.local" });

/** §14.2 Vancouver seed. Idempotent — safe to re-run. */
export async function seed(db: ReturnType<typeof createDb>, opts: { sampleOrders?: boolean } = {}) {
  const [showroom] = await db
    .insert(showrooms)
    .values({
      slug: "vancouver",
      name: "Biktrix Vancouver",
      timezone: "America/Vancouver",
      addressLine: "2825 Grandview Hwy, Vancouver, BC V5M 2E1",
      phone: "1-866-245-8749 ext. 803",
      settings: { ...DEFAULT_SETTINGS },
    })
    .onConflictDoUpdate({
      target: showrooms.slug,
      set: { name: "Biktrix Vancouver", timezone: "America/Vancouver" },
    })
    .returning();

  const template = [
    { weekday: 0, capacity: 0, windowStart: "12:00", windowEnd: "17:15", maxConcurrent: 1 },
    { weekday: 1, capacity: 0, windowStart: "12:00", windowEnd: "17:15", maxConcurrent: 1 },
    { weekday: 2, capacity: 3, windowStart: "12:00", windowEnd: "17:15", maxConcurrent: 1 },
    { weekday: 3, capacity: 3, windowStart: "12:00", windowEnd: "17:15", maxConcurrent: 1 },
    { weekday: 4, capacity: 3, windowStart: "12:00", windowEnd: "17:15", maxConcurrent: 1 },
    { weekday: 5, capacity: 3, windowStart: "12:00", windowEnd: "17:15", maxConcurrent: 1 },
    { weekday: 6, capacity: 6, windowStart: "11:00", windowEnd: "17:15", maxConcurrent: 1 },
  ];
  for (const t of template) {
    await db
      .insert(capacityRules)
      .values({ showroomId: showroom.id, ...t })
      .onConflictDoNothing();
  }

  const adminEmail = (process.env.AUTH_ALLOWED_EMAILS ?? "gord@biktrix.com").split(",")[0].trim();
  await db
    .insert(staffUsers)
    .values({ email: adminEmail, name: "Gordon", role: "admin", showroomId: null })
    .onConflictDoNothing();

  if (opts.sampleOrders) {
    const existing = await db.select({ id: orders.id }).from(orders).where(eq(orders.showroomId, showroom.id));
    if (existing.length === 0) {
      await db.insert(orders).values([
        {
          showroomId: showroom.id,
          orderRef: "LS-48213",
          source: "lightspeed",
          customerName: "Jane Doe",
          customerEmail: "jane@example.com",
          customerPhone: "+16045550123",
          model: "Juggernaut Ultra Beast 2",
          size: "Regular",
          colour: "Matte Black",
          orderDate: "2026-06-14",
          paymentStatus: "deposit",
          balanceCents: 125000,
          termsVersion: 1,
          notes: "wants rack installed",
        },
        {
          showroomId: showroom.id,
          orderRef: "SH-100421",
          source: "shopify",
          customerName: "Sam Lee",
          customerEmail: "sam@example.com",
          customerPhone: "+17785550199",
          model: "Swift Step-Thru",
          size: "One size",
          colour: "Sage",
          orderDate: "2026-07-02",
          paymentStatus: "paid",
          balanceCents: 0,
          termsVersion: 1,
        },
        {
          showroomId: showroom.id,
          orderRef: "LS-48390",
          source: "lightspeed",
          customerName: "Priya Nair",
          customerEmail: "priya@example.com",
          customerPhone: "+16045550177",
          model: "Juggernaut Ultra Beast 2",
          size: "Regular",
          colour: "Matte Black",
          orderDate: "2026-07-20",
          paymentStatus: "paid",
          balanceCents: 0,
          termsVersion: 2,
        },
      ]);
    }
  }
  return showroom;
}

if (process.argv[1]?.endsWith("seed.ts")) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const db = createDb(url);
  seed(db, { sampleOrders: process.argv.includes("--sample") })
    .then(async (s) => {
      console.log(`Seeded showroom ${s.slug} (${s.id})`);
      await db.$client.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
