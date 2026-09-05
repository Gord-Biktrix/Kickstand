import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { appointments, dayCounters, units } from "@/db/schema";
import { getAvailability } from "@/lib/availability";
import { bookGroup, bookSlot, cancelBooking, recordNoShow, rescheduleBooking } from "@/lib/booking";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import type { ShowroomCtx } from "@/lib/showroom";
import { localToUtc } from "@/lib/time";
import { inviteUnit, inviteUnits } from "@/lib/units";
import { makeOrder, makeUnit, resetDb, testDb, TZ } from "./helpers";

let db: Db;
let showroom: ShowroomCtx;
let notifier: MemoryNotifier;
const NOW = localToUtc("2026-09-01", "10:00", TZ);
const SAT = localToUtc("2026-09-12", "11:00", TZ); // Saturday window opens 11:00

async function twoBikes() {
  // Same person, two orders (two Lightspeed special-order lines), two boxes.
  const o1 = await makeOrder(db, showroom, { orderRef: "SO1", customerName: "Pat Benell", customerPhone: "+16045550100", lsCustomerId: "77" });
  const o2 = await makeOrder(db, showroom, { orderRef: "SO2", customerName: "Pat Benell", customerPhone: "+16045550100", lsCustomerId: "77", model: "Stunner Lite 3", colour: "Silver" });
  const u1 = await makeUnit(db, showroom, o1.id, { boxTag: "SO1" });
  const u2 = await makeUnit(db, showroom, o2.id, { boxTag: "SO2" });
  return { o1, o2, u1, u2 };
}
const counter = async (d: string) => (await db.select().from(dayCounters).where(eq(dayCounters.onDate, d)))[0]?.bookedCount ?? 0;
const booked = async (unitId: string) => (await db.select().from(appointments).where(and(eq(appointments.unitId, unitId), eq(appointments.status, "booked"))))[0] ?? null;

beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.$client.end(); });
beforeEach(async () => { showroom = await resetDb(db); notifier = new MemoryNotifier(); setNotifier(notifier); });

describe("one visit, several bikes", () => {
  it("books two bikes as one visit: same time, shared group, capacity counts both, one message", async () => {
    const { u1, u2 } = await twoBikes();
    await inviteUnit(db, { showroom, unitId: u1.id, actor: "s", now: NOW });
    await inviteUnit(db, { showroom, unitId: u2.id, actor: "s", now: NOW });
    notifier.sent = [];
    const r = await bookGroup(db, { showroom, unitIds: [u1.id, u2.id], startsAt: SAT, createdBy: "customer", now: NOW });
    expect(r.groupId).toBeTruthy();
    expect(r.all).toHaveLength(2);
    expect(r.all.every((a) => a.appointment.groupId === r.groupId && a.appointment.startsAt.getTime() === SAT.getTime())).toBe(true);
    expect(await counter("2026-09-12")).toBe(2); // max_concurrent 1 did not block the sibling
    expect(notifier.sent.map((m) => m.metric)).toEqual(["Pickup: Booked"]);
    expect(notifier.sent[0].properties.bike_count).toBe(2);
    expect(notifier.sent[0].properties.bikes).toHaveLength(2);
    const us = await db.select().from(units).where(eq(units.orderId, u1.orderId!));
    expect(us[0].status).toBe("booked");
  });

  it("cancelling one bike cancels the visit; rescheduling moves both; a no-show hits both", async () => {
    const { u1, u2 } = await twoBikes();
    await inviteUnit(db, { showroom, unitId: u1.id, actor: "s", now: NOW });
    await inviteUnit(db, { showroom, unitId: u2.id, actor: "s", now: NOW });
    await bookGroup(db, { showroom, unitIds: [u1.id, u2.id], startsAt: SAT, createdBy: "customer", now: NOW });

    notifier.sent = [];
    const moved = localToUtc("2026-09-15", "12:00", TZ);
    const rs = await rescheduleBooking(db, { showroom, unitId: u2.id, startsAt: moved, actor: "customer", now: NOW });
    expect(rs.appointment.startsAt.getTime()).toBe(moved.getTime());
    expect((await booked(u1.id))?.startsAt.getTime()).toBe(moved.getTime());
    expect((await booked(u1.id))?.groupId).toBe((await booked(u2.id))?.groupId);
    expect(await counter("2026-09-12")).toBe(0);
    expect(await counter("2026-09-15")).toBe(2);
    expect(notifier.sent.map((m) => m.metric)).toEqual(["Pickup: Rescheduled"]);
    expect(notifier.sent[0].properties.bike_count).toBe(2);

    notifier.sent = [];
    await cancelBooking(db, { showroom, unitId: u1.id, reason: "customer", actor: "customer", now: NOW });
    expect(await booked(u1.id)).toBeNull();
    expect(await booked(u2.id)).toBeNull();
    expect(await counter("2026-09-15")).toBe(0);
    expect(notifier.sent.map((m) => m.metric)).toEqual(["Pickup: Cancelled"]);
    expect(notifier.sent[0].properties.bike_count).toBe(2);

    await bookGroup(db, { showroom, unitIds: [u1.id, u2.id], startsAt: SAT, createdBy: "customer", now: NOW });
    notifier.sent = [];
    const after = new Date(SAT.getTime() + 3_600_000);
    const ns = await recordNoShow(db, { showroom, unitId: u1.id, actor: "staff", now: after });
    expect(ns.noShowCount).toBe(1);
    expect(await booked(u2.id)).toBeNull();
    const [u2fresh] = await db.select().from(units).where(eq(units.id, u2.id));
    expect(u2fresh.noShowCount).toBe(1);
    expect(notifier.sent.map((m) => m.metric)).toEqual(["Pickup: Missed"]);
  });

  it("availability for two bikes needs two free places", async () => {
    const { u1 } = await twoBikes();
    await inviteUnit(db, { showroom, unitId: u1.id, actor: "s", now: NOW });
    const [unit] = await db.select().from(units).where(eq(units.id, u1.id));
    // Tuesday capacity is 3: with 2 already booked, one bike fits, two do not.
    const others = [await makeOrder(db, showroom, { customerPhone: "+16045550201" }), await makeOrder(db, showroom, { customerPhone: "+16045550202" })];
    for (const o of others) {
      const u = await makeUnit(db, showroom, o.id);
      await inviteUnit(db, { showroom, unitId: u.id, actor: "s", now: NOW });
      await bookSlot(db, { showroom, unitId: u.id, startsAt: localToUtc("2026-09-08", u === undefined ? "12:00" : others.indexOf(o) === 0 ? "12:00" : "12:45", TZ), createdBy: "customer", now: NOW });
    }
    const one = (await getAvailability(db, { showroom, unit, order: null, now: NOW })).find((d) => d.date === "2026-09-08")!;
    const two = (await getAvailability(db, { showroom, unit, order: null, now: NOW, count: 2 })).find((d) => d.date === "2026-09-08")!;
    expect(one.remaining).toBe(1);
    expect(one.bookable).toBe(true);
    expect(two.remaining).toBe(0);
    expect(two.bookable).toBe(false);
  });

  it("inviting two bikes for one person sends one message; a later bike joins the booked visit", async () => {
    const { u1, u2 } = await twoBikes();
    notifier.sent = [];
    const r = await inviteUnits(db, { showroom, unitIds: [u1.id, u2.id], actor: "s", now: NOW });
    expect(r).toMatchObject({ invited: 2, joined: 0, skipped: [] });
    expect(notifier.sent.map((m) => m.metric)).toEqual(["Pickup: Bike Arrived"]);
    expect(notifier.sent[0].properties.bike_count).toBe(2);
    const [a, b] = await db.select().from(units).where(eq(units.showroomId, showroom.id));
    expect([a.status, b.status]).toEqual(["invited", "invited"]);

    // The customer books both; then a third bike lands.
    await bookGroup(db, { showroom, unitIds: [u1.id, u2.id], startsAt: SAT, createdBy: "customer", now: NOW });
    const o3 = await makeOrder(db, showroom, { orderRef: "SO3", customerName: "Pat Benell", customerPhone: "+16045550100", lsCustomerId: "77", model: "Swift CVT Lite" });
    const u3 = await makeUnit(db, showroom, o3.id, { boxTag: "SO3" });
    notifier.sent = [];
    const r2 = await inviteUnits(db, { showroom, unitIds: [u3.id], actor: "s", now: localToUtc("2026-09-03", "10:00", TZ) });
    expect(r2).toMatchObject({ invited: 0, joined: 1 });
    const a3 = await booked(u3.id);
    expect(a3?.startsAt.getTime()).toBe(SAT.getTime());
    expect(a3?.groupId).toBe((await booked(u1.id))?.groupId);
    expect(await counter("2026-09-12")).toBe(3);
    expect(notifier.sent.map((m) => m.metric)).toEqual(["Pickup: Bike Arrived"]);
    expect(notifier.sent[0].properties.joined_existing_pickup).toBe(true);
    expect(notifier.sent[0].properties.slot_start_local).toContain("12 September");
  });
});
