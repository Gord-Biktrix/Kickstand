import { fromZonedTime } from "date-fns-tz";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb, type Db } from "@/db/client";
import { orders, units } from "@/db/schema";
import { getShowroom, patchShowroomSettings, type ShowroomCtx } from "@/lib/showroom";
import type { ProgramSettings } from "@/lib/settings";
import { seed } from "../scripts/seed";

export const TZ = "America/Vancouver";

export async function testDb(): Promise<Db> {
  const db = createDb(process.env.DATABASE_URL!);
  await migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

export async function resetDb(db: Db): Promise<ShowroomCtx> {
  await db.execute(sql`
    truncate table events, appointments, day_counters, units, orders, capacity_overrides, lightspeed_connections,
      capacity_rules, staff_sessions, magic_links, staff_users, showrooms cascade
  `);
  await seed(db);
  return getShowroom(db);
}

export async function withSettings(db: Db, showroom: ShowroomCtx, patch: Partial<ProgramSettings>) {
  await patchShowroomSettings(db, showroom.id, patch);
  return getShowroom(db);
}

export async function makeOrder(
  db: Db,
  showroom: ShowroomCtx,
  overrides: Partial<typeof orders.$inferInsert> = {},
) {
  const [o] = await db
    .insert(orders)
    .values({
      showroomId: showroom.id,
      orderRef: `T-${Math.random().toString(36).slice(2, 8)}`,
      source: "manual",
      customerName: "Test Customer",
      customerEmail: "test@example.com",
      customerPhone: "+16045550100",
      model: "Juggernaut Ultra Beast 2",
      size: "Regular",
      colour: "Matte Black",
      orderDate: "2026-07-01",
      paymentStatus: "paid",
      balanceCents: 0,
      termsVersion: 2,
      ...overrides,
    })
    .returning();
  return o;
}

export async function makeUnit(
  db: Db,
  showroom: ShowroomCtx,
  orderId: string,
  overrides: Partial<typeof units.$inferInsert> = {},
) {
  const [u] = await db
    .insert(units)
    .values({
      showroomId: showroom.id,
      orderId,
      boxTag: `BOX-${Math.random().toString(36).slice(2, 8)}`,
      model: "Juggernaut Ultra Beast 2",
      size: "Regular",
      colour: "Matte Black",
      status: "received",
      receivedAt: new Date(),
      ...overrides,
    })
    .returning();
  return u;
}

/** A Vancouver local wall-clock instant. */
export function van(date: string, time: string): Date {
  return fromZonedTime(`${date}T${time}`, TZ);
}
