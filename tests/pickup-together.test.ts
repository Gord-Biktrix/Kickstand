import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { appointments, orders, units } from "@/db/schema";
import { bookGroup, bookSlot } from "@/lib/booking";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import type { ShowroomCtx } from "@/lib/showroom";
import { localToUtc } from "@/lib/time";
import { bookableSiblings, inviteOrders, linkOrdersForPickup, unlinkOrderPickup } from "@/lib/units";
import { makeOrder, resetDb, testDb, TZ } from "./helpers";

let db: Db;
let showroom: ShowroomCtx;
let notifier: MemoryNotifier;
const NOW = localToUtc("2026-09-01", "10:00", TZ);
const SAT = localToUtc("2026-09-12", "11:00", TZ);

async function couple() {
  const john = await makeOrder(db, showroom, { orderRef: "SO-J", customerName: "John Doe", customerPhone: "+16045550101", customerEmail: "john@example.com" });
  const sally = await makeOrder(db, showroom, { orderRef: "SO-S", customerName: "Sally Doe", customerPhone: "+16045550102", customerEmail: "sally@example.com", model: "Stunner Lite 3" });
  return { john, sally };
}
const unitOf = async (orderId: string) => (await db.select().from(units).where(eq(units.orderId, orderId)))[0];
const active = async (unitId: string) => (await db.select().from(appointments).where(and(eq(appointments.unitId, unitId), eq(appointments.status, "booked"))))[0] ?? null;

beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.$client.end(); });
beforeEach(async () => { showroom = await resetDb(db); notifier = new MemoryNotifier(); setNotifier(notifier); });

describe("pick up together (On order)", () => {
  it("invited together: each person hears about both bikes, and either can book both", async () => {
    const { john, sally } = await couple();
    await linkOrdersForPickup(db, { showroom, orderIds: [john.id, sally.id], actor: "s" });
    await inviteOrders(db, { showroom, orderIds: [john.id, sally.id], actor: "s", now: NOW });
    const arrived = notifier.sent.filter((m) => m.metric === "Pickup: Bike Arrived");
    expect(arrived.map((m) => m.profile.phone).sort()).toEqual(["+16045550101", "+16045550102"]);
    expect(arrived.every((m) => m.properties.bike_count === 2)).toBe(true);

    const [uj, us] = [await unitOf(john.id), await unitOf(sally.id)];
    const [johnOrder] = await db.select().from(orders).where(eq(orders.id, john.id));
    expect((await bookableSiblings(db, showroom, uj, johnOrder)).map((x) => x.unit.id)).toEqual([us.id]);

    notifier.sent = [];
    await bookGroup(db, { showroom, unitIds: [uj.id, us.id], startsAt: SAT, createdBy: "customer", now: NOW });
    expect((await active(uj.id)).groupId).toBe((await active(us.id)).groupId);
    expect(notifier.sent.map((m) => m.profile.phone).sort()).toEqual(["+16045550101", "+16045550102"]);
  });

  it("arriving at different times: the second bike joins the first one's pickup", async () => {
    const { john, sally } = await couple();
    await linkOrdersForPickup(db, { showroom, orderIds: [john.id, sally.id], actor: "s" });
    await inviteOrders(db, { showroom, orderIds: [john.id], actor: "s", now: NOW });
    const uj = await unitOf(john.id);
    await bookSlot(db, { showroom, unitId: uj.id, startsAt: SAT, createdBy: "customer", now: NOW });

    notifier.sent = [];
    const r = await inviteOrders(db, { showroom, orderIds: [sally.id], actor: "s", now: NOW });
    expect(r.invited).toBe(1);
    const us = await unitOf(sally.id);
    const [a, b] = [await active(uj.id), await active(us.id)];
    expect(b.startsAt.getTime()).toBe(SAT.getTime());
    expect(b.groupId).toBe(a.groupId);
    expect(notifier.sent.map((m) => [m.metric, m.profile.phone, m.properties.joined_existing_pickup])).toEqual([["Pickup: Bike Arrived", "+16045550102", true]]);
  });

  it("unlinking gives each bike its own pickup again", async () => {
    const { john, sally } = await couple();
    const third = await makeOrder(db, showroom, { orderRef: "SO-K", customerName: "Kid Doe", customerPhone: "+16045550103" });
    await linkOrdersForPickup(db, { showroom, orderIds: [john.id, sally.id], actor: "s" });
    // Linking a third to one of them joins the same group.
    await linkOrdersForPickup(db, { showroom, orderIds: [sally.id, third.id], actor: "s" });
    const groups = new Set((await db.select().from(orders)).map((o) => o.pickupGroup));
    expect(groups.size).toBe(1);

    await unlinkOrderPickup(db, { showroom, orderId: third.id, actor: "s" });
    await unlinkOrderPickup(db, { showroom, orderId: john.id, actor: "s" });
    // Sally alone is no longer a group.
    expect((await db.select().from(orders)).every((o) => o.pickupGroup === null)).toBe(true);
  });

  it("needs two bikes", async () => {
    const { john } = await couple();
    await expect(linkOrdersForPickup(db, { showroom, orderIds: [john.id], actor: "s" })).rejects.toThrow("at least two");
  });
});
