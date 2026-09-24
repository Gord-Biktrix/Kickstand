import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { appointments, dayCounters } from "@/db/schema";
import { bookGroup, bookSlot, cancelBooking, rescheduleBooking } from "@/lib/booking";
import { runClock } from "@/lib/clock";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import type { ShowroomCtx } from "@/lib/showroom";
import { localToUtc } from "@/lib/time";
import { combineCandidates, inviteUnit, mergeIntoVisit, splitFromVisit } from "@/lib/units";
import { makeOrder, makeUnit, resetDb, testDb, TZ } from "./helpers";

let db: Db;
let showroom: ShowroomCtx;
let notifier: MemoryNotifier;
const NOW = localToUtc("2026-09-01", "10:00", TZ);
const SAT = localToUtc("2026-09-12", "11:00", TZ);
const TUE = localToUtc("2026-09-15", "12:00", TZ);

/** A couple: two orders under two names, two phone numbers. */
async function couple() {
  const john = await makeOrder(db, showroom, { orderRef: "SO-J", customerName: "John Doe", customerPhone: "+16045550101", customerEmail: "john@example.com" });
  const sally = await makeOrder(db, showroom, { orderRef: "SO-S", customerName: "Sally Doe", customerPhone: "+16045550102", customerEmail: "sally@example.com", model: "Stunner Lite 3" });
  const uj = await makeUnit(db, showroom, john.id, { boxTag: "J1" });
  const us = await makeUnit(db, showroom, sally.id, { boxTag: "S1", model: "Stunner Lite 3" });
  await inviteUnit(db, { showroom, unitId: uj.id, actor: "s", now: NOW });
  await inviteUnit(db, { showroom, unitId: us.id, actor: "s", now: NOW });
  return { john, sally, uj, us };
}
const active = async (unitId: string) => (await db.select().from(appointments).where(and(eq(appointments.unitId, unitId), eq(appointments.status, "booked"))))[0] ?? null;
const counter = async (d: string) => (await db.select().from(dayCounters).where(eq(dayCounters.onDate, d)))[0]?.bookedCount ?? 0;
const phones = () => notifier.sent.map((m) => m.profile.phone).sort();

beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.$client.end(); });
beforeEach(async () => { showroom = await resetDb(db); notifier = new MemoryNotifier(); setNotifier(notifier); });

describe("combine pickups", () => {
  it("combines two customers' bookings into one visit, keeping the chosen time, with no penalty", async () => {
    const { uj, us } = await couple();
    const johnAppt = (await bookSlot(db, { showroom, unitId: uj.id, startsAt: SAT, createdBy: "customer", now: NOW })).appointment;
    const sallyOld = (await bookSlot(db, { showroom, unitId: us.id, startsAt: TUE, createdBy: "customer", now: NOW })).appointment;
    notifier.sent = [];

    const r = await mergeIntoVisit(db, { showroom, unitId: us.id, into: johnAppt, actor: "staff-1", now: NOW, notify: true });
    expect(r.moved).toEqual([us.id]);
    const [j, s] = [await active(uj.id), await active(us.id)];
    expect(s.startsAt.getTime()).toBe(SAT.getTime());
    expect(s.groupId).toBeTruthy();
    expect(s.groupId).toBe(j.groupId);
    const [old] = await db.select().from(appointments).where(eq(appointments.id, sallyOld.id));
    expect(old).toMatchObject({ status: "cancelled", cancelledReason: "staff", replacedBy: s.id });
    expect(await counter("2026-09-12")).toBe(2);
    expect(await counter("2026-09-15")).toBe(0);
    // Only Sally's time changed, so only Sally is told.
    expect(notifier.sent.map((m) => [m.metric, m.profile.phone])).toEqual([["Pickup: Rescheduled", "+16045550102"]]);
    expect(notifier.sent[0].properties.bike_count).toBe(2);
  });

  it("reminds, reschedules and cancels a combined visit for both customers", async () => {
    const { uj, us } = await couple();
    const johnAppt = (await bookSlot(db, { showroom, unitId: uj.id, startsAt: SAT, createdBy: "customer", now: NOW })).appointment;
    await mergeIntoVisit(db, { showroom, unitId: us.id, into: johnAppt, actor: "s", now: NOW, notify: false });

    notifier.sent = [];
    await runClock(db, { now: localToUtc("2026-09-11", "17:30", TZ), skipSpecialOrders: true, deliveryFeed: null, forceReminders: true });
    expect(notifier.sent.filter((m) => m.metric === "Pickup: Reminder Day Before").map((m) => m.profile.phone).sort()).toEqual(["+16045550101", "+16045550102"]);

    notifier.sent = [];
    await rescheduleBooking(db, { showroom, unitId: us.id, startsAt: TUE, actor: "customer", now: NOW });
    expect(notifier.sent.every((m) => m.metric === "Pickup: Rescheduled")).toBe(true);
    expect(phones()).toEqual(["+16045550101", "+16045550102"]);
    expect((await active(uj.id)).startsAt.getTime()).toBe(TUE.getTime());

    notifier.sent = [];
    await cancelBooking(db, { showroom, unitId: uj.id, reason: "shop", actor: "s", now: NOW });
    expect(notifier.sent.every((m) => m.metric === "Pickup: Cancelled")).toBe(true);
    expect(phones()).toEqual(["+16045550101", "+16045550102"]);
    expect(await active(us.id)).toBeNull();
  });

  it("brings every bike of a multi-bike visit along", async () => {
    const { john, uj, us } = await couple();
    const uj2 = await makeUnit(db, showroom, john.id, { boxTag: "J2" });
    await inviteUnit(db, { showroom, unitId: uj2.id, actor: "s", now: NOW });
    await bookGroup(db, { showroom, unitIds: [uj.id, uj2.id], startsAt: TUE, createdBy: "customer", now: NOW });
    const sallyAppt = (await bookSlot(db, { showroom, unitId: us.id, startsAt: SAT, createdBy: "customer", now: NOW })).appointment;
    const r = await mergeIntoVisit(db, { showroom, unitId: uj2.id, into: sallyAppt, actor: "s", now: NOW, notify: false });
    expect(r.moved.sort()).toEqual([uj.id, uj2.id].sort());
    const groups = new Set([(await active(uj.id)).groupId, (await active(uj2.id)).groupId, (await active(us.id)).groupId]);
    expect(groups.size).toBe(1);
    expect(await counter("2026-09-12")).toBe(3);
    expect(await counter("2026-09-15")).toBe(0);
  });

  it("adds an unbooked bike to a booked pickup and tells that customer", async () => {
    const { uj, us } = await couple();
    const johnAppt = (await bookSlot(db, { showroom, unitId: uj.id, startsAt: SAT, createdBy: "customer", now: NOW })).appointment;
    notifier.sent = [];
    await mergeIntoVisit(db, { showroom, unitId: us.id, into: johnAppt, actor: "s", now: NOW, notify: true });
    expect((await active(us.id)).groupId).toBe((await active(uj.id)).groupId);
    expect(notifier.sent.map((m) => [m.metric, m.profile.phone, m.properties.joined_existing_pickup])).toEqual([["Pickup: Bike Arrived", "+16045550102", true]]);
  });

  it("refuses to combine a pickup with itself", async () => {
    const { uj, us } = await couple();
    const johnAppt = (await bookSlot(db, { showroom, unitId: uj.id, startsAt: SAT, createdBy: "customer", now: NOW })).appointment;
    await mergeIntoVisit(db, { showroom, unitId: us.id, into: johnAppt, actor: "s", now: NOW, notify: false });
    await expect(mergeIntoVisit(db, { showroom, unitId: us.id, into: (await active(uj.id))!, actor: "s", now: NOW, notify: false })).rejects.toThrow("already in the same pickup");
  });

  it("books two customers' unbooked bikes together with one Booked text each", async () => {
    const { uj, us } = await couple();
    notifier.sent = [];
    await bookGroup(db, { showroom, unitIds: [uj.id, us.id], startsAt: SAT, createdBy: "staff-1", now: NOW });
    expect(notifier.sent.map((m) => m.metric)).toEqual(["Pickup: Booked", "Pickup: Booked"]);
    expect(phones()).toEqual(["+16045550101", "+16045550102"]);
  });

  it("suggests the partner by surname and finds anyone by search", async () => {
    const { john, uj, us } = await couple();
    const other = await makeOrder(db, showroom, { orderRef: "SO-X", customerName: "Alex Smith", customerPhone: "+16045550199" });
    const ux = await makeUnit(db, showroom, other.id, { boxTag: "X1" });
    await inviteUnit(db, { showroom, unitId: ux.id, actor: "s", now: NOW });
    const suggested = await combineCandidates(db, showroom, uj, john, "", NOW);
    expect(suggested.map((c) => [c.unit.id, c.why])).toEqual([[us.id, "Same surname"]]);
    const searched = await combineCandidates(db, showroom, uj, john, "smith", NOW);
    expect(searched.map((c) => c.unit.id)).toEqual([ux.id]);
  });
});

describe("split a pickup", () => {
  it("moves one bike to its own booking; the rest of the visit stays", async () => {
    const { uj, us } = await couple();
    const johnAppt = (await bookSlot(db, { showroom, unitId: uj.id, startsAt: SAT, createdBy: "customer", now: NOW })).appointment;
    await mergeIntoVisit(db, { showroom, unitId: us.id, into: johnAppt, actor: "s", now: NOW, notify: false });
    notifier.sent = [];

    await splitFromVisit(db, { showroom, unitId: us.id, startsAt: TUE, actor: "s", now: NOW, notify: true });
    const [j, s] = [await active(uj.id), await active(us.id)];
    expect(j.startsAt.getTime()).toBe(SAT.getTime());
    expect(s.startsAt.getTime()).toBe(TUE.getTime());
    expect(s.groupId).toBeNull();
    expect(await counter("2026-09-12")).toBe(1);
    expect(await counter("2026-09-15")).toBe(1);
    expect(notifier.sent.map((m) => [m.metric, m.profile.phone])).toEqual([["Pickup: Rescheduled", "+16045550102"]]);

    // Separate from now on: rescheduling John leaves Sally where she is.
    await rescheduleBooking(db, { showroom, unitId: uj.id, startsAt: localToUtc("2026-09-16", "12:00", TZ), actor: "customer", now: NOW });
    expect((await active(us.id)).startsAt.getTime()).toBe(TUE.getTime());
  });

  it("refuses to split a bike that already has its own pickup", async () => {
    const { uj } = await couple();
    await bookSlot(db, { showroom, unitId: uj.id, startsAt: SAT, createdBy: "customer", now: NOW });
    await expect(splitFromVisit(db, { showroom, unitId: uj.id, startsAt: TUE, actor: "s", now: NOW, notify: false })).rejects.toThrow("already has its own pickup");
  });
});
