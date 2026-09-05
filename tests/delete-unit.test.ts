import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { appointments, dayCounters, events, orders, units } from "@/db/schema";
import { bookSlot } from "@/lib/booking";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import type { ShowroomCtx } from "@/lib/showroom";
import { localToUtc } from "@/lib/time";
import { deleteUnit, inviteUnit } from "@/lib/units";
import { makeOrder, makeUnit, resetDb, testDb, TZ } from "./helpers";

let db: Db;
let showroom: ShowroomCtx;
const NOW = localToUtc("2026-09-01", "10:00", TZ);

beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.$client.end(); });
beforeEach(async () => { showroom = await resetDb(db); setNotifier(new MemoryNotifier()); });

describe("deleteUnit (manager hard delete)", () => {
  it("removes the bike, its booking, its history and a now-empty order, and frees the day's counter", async () => {
    const order = await makeOrder(db, showroom);
    const unit = await makeUnit(db, showroom, order.id);
    await inviteUnit(db, { showroom, unitId: unit.id, actor: "s", now: NOW });
    await bookSlot(db, { showroom, unitId: unit.id, startsAt: localToUtc("2026-09-08", "12:00", TZ), createdBy: "customer", now: NOW });
    expect((await db.select().from(dayCounters).where(eq(dayCounters.onDate, "2026-09-08")))[0].bookedCount).toBe(1);

    const res = await deleteUnit(db, { showroom, unitId: unit.id, actor: "manager-1", reason: "test booking" });
    expect(res).toEqual({ boxTag: unit.boxTag, orderDeleted: true });
    expect(await db.select().from(units).where(eq(units.id, unit.id))).toEqual([]);
    expect(await db.select().from(appointments).where(eq(appointments.unitId, unit.id))).toEqual([]);
    expect(await db.select().from(orders).where(eq(orders.id, order.id))).toEqual([]);
    expect(await db.select().from(events).where(eq(events.unitId, unit.id))).toEqual([]);
    expect((await db.select().from(dayCounters).where(eq(dayCounters.onDate, "2026-09-08")))[0].bookedCount).toBe(0);
    const log = await db.select().from(events).where(eq(events.type, "unit_deleted"));
    expect(log).toHaveLength(1);
    expect(log[0].payload).toMatchObject({ reason: "test booking", box_tag: unit.boxTag, order_deleted: true });
  });

  it("keeps the order when another bike still belongs to it", async () => {
    const order = await makeOrder(db, showroom);
    const a = await makeUnit(db, showroom, order.id, { boxTag: "A" });
    await makeUnit(db, showroom, order.id, { boxTag: "B" });
    const res = await deleteUnit(db, { showroom, unitId: a.id, actor: "manager-1", reason: "duplicate" });
    expect(res.orderDeleted).toBe(false);
    expect(await db.select().from(orders).where(eq(orders.id, order.id))).toHaveLength(1);
  });
});
