import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { events, orders, units } from "@/db/schema";
import { bookSlot } from "@/lib/booking";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import type { ShowroomCtx } from "@/lib/showroom";
import { localToUtc } from "@/lib/time";
import { inviteUnit, unreceiveUnit } from "@/lib/units";
import { makeOrder, makeUnit, resetDb, testDb, TZ } from "./helpers";

let db: Db;
let showroom: ShowroomCtx;
const NOW = localToUtc("2026-09-01", "10:00", TZ);
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.$client.end(); });
beforeEach(async () => { showroom = await resetDb(db); setNotifier(new MemoryNotifier()); });

describe("unreceiveUnit (Back to On order)", () => {
  it("removes an invited bike and keeps the order open with a log entry", async () => {
    const order = await makeOrder(db, showroom, { orderRef: "SO75974" });
    const unit = await makeUnit(db, showroom, order.id, { boxTag: "SO75974" });
    await inviteUnit(db, { showroom, unitId: unit.id, actor: "s", now: NOW });
    const r = await unreceiveUnit(db, { showroom, unitId: unit.id, actor: "staff-1" });
    expect(r.orderRef).toBe("SO75974");
    expect(await db.select().from(units).where(eq(units.id, unit.id))).toEqual([]);
    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.status).toBe("open");
    const log = await db.select().from(events).where(eq(events.type, "unit_unreceived"));
    expect(log).toHaveLength(1);
    expect(log[0].payload).toMatchObject({ box_tag: "SO75974", status_before: "invited" });
  });

  it("refuses when the bike is booked or already building", async () => {
    const order = await makeOrder(db, showroom);
    const unit = await makeUnit(db, showroom, order.id);
    await inviteUnit(db, { showroom, unitId: unit.id, actor: "s", now: NOW });
    await bookSlot(db, { showroom, unitId: unit.id, startsAt: localToUtc("2026-09-08", "12:00", TZ), createdBy: "customer", now: NOW });
    await expect(unreceiveUnit(db, { showroom, unitId: unit.id, actor: "s" })).rejects.toThrow(/received or invited|Cancel the booking/);
  });
});
