import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { appointments, dayCounters, events, orders, units } from "@/db/schema";
import { getAvailability } from "@/lib/availability";
import { BookingError, bookSlot, cancelBooking, recordNoShow, rescheduleBooking } from "@/lib/booking";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import type { ShowroomCtx } from "@/lib/showroom";
import { localToUtc } from "@/lib/time";
import { completeHandover, detachUnit, grantExtension, HANDOVER_CHECKLIST, inviteUnit, receiveUnit, retagUnit } from "@/lib/units";
import { makeOrder, makeUnit, resetDb, testDb, TZ, withSettings } from "./helpers";

let db: Db;
let showroom: ShowroomCtx;
let notifier: MemoryNotifier;
const NOW = localToUtc("2026-09-01", "10:00", TZ); // Tuesday

async function invitedUnit(overrides: Parameters<typeof makeOrder>[2] = {}) {
  const order = await makeOrder(db, showroom, overrides);
  const unit = await makeUnit(db, showroom, order.id);
  const { unit: invited, token } = await inviteUnit(db, { showroom, unitId: unit.id, actor: "staff-1", now: NOW });
  return { order, unit: invited, token };
}

beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.$client.end();
});
beforeEach(async () => {
  showroom = await resetDb(db);
  notifier = new MemoryNotifier();
  setNotifier(notifier);
});

describe("invite (R7)", () => {
  it("sets book-by and pick-up-by at end of local day and sends Bike Arrived", async () => {
    const { unit } = await invitedUnit();
    expect(unit.status).toBe("invited");
    expect(unit.bookBy?.toISOString()).toBe(localToUtc("2026-09-15", "23:59:59", TZ).toISOString());
    expect(unit.pickupBy?.toISOString()).toBe(localToUtc("2026-09-22", "23:59:59", TZ).toISOString());
    expect(notifier.sent.map((s) => s.metric)).toEqual(["Pickup: Bike Arrived"]);
    expect(String(notifier.sent[0].properties.booking_url)).toMatch(/\/b\/.+\/book$/);
  });

  it("refuses to invite an order with no contact details", async () => {
    const order = await makeOrder(db, showroom, { customerEmail: null, customerPhone: null });
    const unit = await makeUnit(db, showroom, order.id);
    await expect(inviteUnit(db, { showroom, unitId: unit.id, actor: "s", now: NOW })).rejects.toThrow(/email or phone/);
  });

  it("receive guards: open order, one active unit per order", async () => {
    const order = await makeOrder(db, showroom);
    await receiveUnit(db, { showroom, orderId: order.id, boxTag: "A1", actor: "s" });
    await expect(receiveUnit(db, { showroom, orderId: order.id, boxTag: "A2", actor: "s" })).rejects.toThrow(/already has a unit/);
  });
});

describe("booking transaction (§6.3)", () => {
  it("books a valid slot, moves the unit to booked and sends Booked", async () => {
    const { unit } = await invitedUnit();
    const startsAt = localToUtc("2026-09-08", "12:00", TZ);
    const { appointment } = await bookSlot(db, { showroom, unitId: unit.id, startsAt, createdBy: "customer", now: NOW });
    expect(appointment.onDate).toBe("2026-09-08");
    const [u] = await db.select().from(units).where(eq(units.id, unit.id));
    expect(u.status).toBe("booked");
    const [c] = await db.select().from(dayCounters).where(eq(dayCounters.onDate, "2026-09-08"));
    expect(c.bookedCount).toBe(1);
    expect(notifier.sent.at(-1)?.metric).toBe("Pickup: Booked");
  });

  it("rejects lead-time, closed, horizon and invalid slots", async () => {
    const { unit } = await invitedUnit();
    const book = (d: string, t: string) => bookSlot(db, { showroom, unitId: unit.id, startsAt: localToUtc(d, t, TZ), createdBy: "customer", now: NOW });
    await expect(book("2026-09-02", "12:00")).rejects.toMatchObject({ code: "TOO_EARLY" });
    await expect(book("2026-09-06", "12:00")).rejects.toMatchObject({ code: "CLOSED" });
    await expect(book("2026-10-14", "12:00")).rejects.toMatchObject({ code: "HORIZON" });
    await expect(book("2026-09-08", "12:10")).rejects.toMatchObject({ code: "INVALID_SLOT" });
  });

  it("two concurrent bookings for the last place: exactly one succeeds", async () => {
    const day = "2026-09-08"; // Tue, X = 3
    const fill = async (time: string) => {
      const { unit } = await invitedUnit();
      return bookSlot(db, { showroom, unitId: unit.id, startsAt: localToUtc(day, time, TZ), createdBy: "customer", now: NOW });
    };
    await fill("12:00");
    await fill("12:45");
    const a = await invitedUnit();
    const b = await invitedUnit();
    const results = await Promise.allSettled([
      bookSlot(db, { showroom, unitId: a.unit.id, startsAt: localToUtc(day, "13:30", TZ), createdBy: "customer", now: NOW }),
      bookSlot(db, { showroom, unitId: b.unit.id, startsAt: localToUtc(day, "14:15", TZ), createdBy: "customer", now: NOW }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0].reason as BookingError).code).toBe("DAY_FULL");
    const [c] = await db.select().from(dayCounters).where(eq(dayCounters.onDate, day));
    expect(c.bookedCount).toBe(3);
    const booked = await db.select().from(appointments).where(and(eq(appointments.onDate, day), eq(appointments.status, "booked")));
    expect(booked).toHaveLength(3);
  });

  it("same time twice with max_concurrent 1 → TIME_FULL and the counter rolls back", async () => {
    const a = await invitedUnit();
    const b = await invitedUnit();
    const startsAt = localToUtc("2026-09-09", "12:00", TZ);
    await bookSlot(db, { showroom, unitId: a.unit.id, startsAt, createdBy: "customer", now: NOW });
    await expect(bookSlot(db, { showroom, unitId: b.unit.id, startsAt, createdBy: "customer", now: NOW })).rejects.toMatchObject({ code: "TIME_FULL" });
    const [c] = await db.select().from(dayCounters).where(eq(dayCounters.onDate, "2026-09-09"));
    expect(c.bookedCount).toBe(1);
  });

  it("availability reflects counters and per-time bookings", async () => {
    const { unit, order } = await invitedUnit();
    const other = await invitedUnit();
    await bookSlot(db, { showroom, unitId: other.unit.id, startsAt: localToUtc("2026-09-08", "12:00", TZ), createdBy: "customer", now: NOW });
    const days = await getAvailability(db, { showroom, unit, order, now: NOW });
    const tue = days.find((d) => d.date === "2026-09-08")!;
    expect(tue.remaining).toBe(2);
    expect(tue.slots.find((s) => s.startLocal === "12:00")?.reason).toBe("time_full");
    expect(days.find((d) => d.date === "2026-09-07")?.bookable).toBe(false); // Monday closed
    expect(days.at(-1)?.date).toBe("2026-10-13"); // invite + 42 days
  });

  it("marks early bird only when enabled and within the window", async () => {
    showroom = await withSettings(db, showroom, { early_bird_enabled: true });
    const { unit } = await invitedUnit();
    const late = new Date(NOW.getTime() + 73 * 3_600_000);
    await bookSlot(db, { showroom, unitId: unit.id, startsAt: localToUtc("2026-09-10", "12:00", TZ), createdBy: "customer", now: NOW });
    const [u] = await db.select().from(units).where(eq(units.id, unit.id));
    expect(u.earlyBird).toBe(true);
    const second = await invitedUnit();
    await bookSlot(db, { showroom, unitId: second.unit.id, startsAt: localToUtc("2026-09-10", "12:45", TZ), createdBy: "customer", now: late });
    const [u2] = await db.select().from(units).where(eq(units.id, second.unit.id));
    expect(u2.earlyBird).toBe(false);
  });
});

describe("cancel, reschedule, no-show (R8, R9)", () => {
  it("cancel outside the cutoff frees the slot and returns the unit to invited", async () => {
    const { unit } = await invitedUnit();
    await bookSlot(db, { showroom, unitId: unit.id, startsAt: localToUtc("2026-09-08", "12:00", TZ), createdBy: "customer", now: NOW });
    const res = await cancelBooking(db, { showroom, unitId: unit.id, reason: "customer", actor: "customer", now: NOW });
    expect(res.lateChange).toBe(false);
    expect(res.appointment.status).toBe("cancelled");
    const [u] = await db.select().from(units).where(eq(units.id, unit.id));
    expect(u.status).toBe("invited");
    expect(u.noShowCount).toBe(0);
    const [c] = await db.select().from(dayCounters).where(eq(dayCounters.onDate, "2026-09-08"));
    expect(c.bookedCount).toBe(0);
    expect(notifier.sent.at(-1)?.metric).toBe("Pickup: Cancelled");
  });

  it("cancel inside the cutoff is recorded as a no-show", async () => {
    const { unit } = await invitedUnit();
    const startsAt = localToUtc("2026-09-08", "12:00", TZ);
    await bookSlot(db, { showroom, unitId: unit.id, startsAt, createdBy: "customer", now: NOW });
    const late = new Date(startsAt.getTime() - 3 * 3_600_000);
    const res = await cancelBooking(db, { showroom, unitId: unit.id, reason: "customer", actor: "customer", now: late });
    expect(res.lateChange).toBe(true);
    expect(res.appointment.status).toBe("no_show");
    const [u] = await db.select().from(units).where(eq(units.id, unit.id));
    expect(u.noShowCount).toBe(1);
  });

  it("a shop cancellation never counts as a no-show but still texts a rebook link; a staff mistake is silent", async () => {
    const { unit } = await invitedUnit();
    const startsAt = localToUtc("2026-09-08", "12:00", TZ);
    await bookSlot(db, { showroom, unitId: unit.id, startsAt, createdBy: "customer", now: NOW });
    const late = new Date(startsAt.getTime() - 3 * 3_600_000);
    notifier.sent = [];
    const res = await cancelBooking(db, { showroom, unitId: unit.id, reason: "shop", actor: "staff-1", now: late });
    expect(res.lateChange).toBe(false);
    expect(res.appointment.status).toBe("cancelled");
    expect(res.appointment.cancelledReason).toBe("shop");
    let [u] = await db.select().from(units).where(eq(units.id, unit.id));
    expect(u.status).toBe("invited");
    expect(u.noShowCount).toBe(0);
    expect(notifier.sent.map((m) => m.metric)).toEqual(["Pickup: Cancelled"]);
    expect(notifier.sent[0].properties.cancelled_by).toBe("shop");

    await bookSlot(db, { showroom, unitId: unit.id, startsAt, createdBy: "staff-1", now: NOW });
    notifier.sent = [];
    await cancelBooking(db, { showroom, unitId: unit.id, reason: "staff", actor: "staff-1", now: late });
    [u] = await db.select().from(units).where(eq(units.id, unit.id));
    expect(u.noShowCount).toBe(0);
    expect(notifier.sent).toEqual([]);
  });

  it("reschedule links old → new and keeps the counters right", async () => {
    const { unit } = await invitedUnit();
    await bookSlot(db, { showroom, unitId: unit.id, startsAt: localToUtc("2026-09-08", "12:00", TZ), createdBy: "customer", now: NOW });
    const res = await rescheduleBooking(db, { showroom, unitId: unit.id, startsAt: localToUtc("2026-09-09", "12:45", TZ), actor: "customer", now: NOW });
    const [old] = await db.select().from(appointments).where(eq(appointments.id, res.previous.id));
    expect(old.status).toBe("cancelled");
    expect(old.replacedBy).toBe(res.appointment.id);
    const counters = await db.select().from(dayCounters);
    expect(Object.fromEntries(counters.map((c) => [c.onDate, c.bookedCount]))).toEqual({ "2026-09-08": 0, "2026-09-09": 1 });
    expect(notifier.sent.at(-1)?.metric).toBe("Pickup: Rescheduled");
    const [u] = await db.select().from(units).where(eq(units.id, unit.id));
    expect(u.status).toBe("booked");
  });

  it("second no-show starts storage; a built bike stays ready and can be rebooked", async () => {
    const { unit } = await invitedUnit();
    const first = localToUtc("2026-09-08", "12:00", TZ);
    await bookSlot(db, { showroom, unitId: unit.id, startsAt: first, createdBy: "customer", now: NOW });
    await db.update(units).set({ status: "ready" }).where(eq(units.id, unit.id));
    await expect(recordNoShow(db, { showroom, unitId: unit.id, actor: "staff", now: NOW })).rejects.toMatchObject({ code: "SLOT_NOT_PASSED" });
    const after1 = new Date(first.getTime() + 3_600_000);
    await recordNoShow(db, { showroom, unitId: unit.id, actor: "staff", now: after1 });
    let [u] = await db.select().from(units).where(eq(units.id, unit.id));
    expect(u.status).toBe("ready");
    expect(u.noShowCount).toBe(1);
    expect(u.storageFrom).toBeNull();
    expect(notifier.sent.at(-1)?.metric).toBe("Pickup: Missed");

    const second = localToUtc("2026-09-11", "12:00", TZ);
    await bookSlot(db, { showroom, unitId: unit.id, startsAt: second, createdBy: "customer", now: after1 });
    [u] = await db.select().from(units).where(eq(units.id, unit.id));
    expect(u.status).toBe("ready"); // bike is built; build board excludes it
    await recordNoShow(db, { showroom, unitId: unit.id, actor: "staff", now: new Date(second.getTime() + 3_600_000) });
    [u] = await db.select().from(units).where(eq(units.id, unit.id));
    expect(u.noShowCount).toBe(2);
    expect(u.storageFrom?.toISOString()).toBe(localToUtc("2026-09-11", "00:00", TZ).toISOString());
    expect(notifier.sent.at(-1)?.properties.second_missed).toBe(true);
  });
});

describe("handover, extension, defer, release", () => {
  it("handover requires the full checklist and storage amounts, then fulfils the order", async () => {
    const { unit, order } = await invitedUnit();
    await bookSlot(db, { showroom, unitId: unit.id, startsAt: localToUtc("2026-09-08", "12:00", TZ), createdBy: "customer", now: NOW });
    await db.update(units).set({ status: "ready" }).where(eq(units.id, unit.id));
    await expect(
      completeHandover(db, { showroom, unitId: unit.id, actor: "staff", checklist: ["fit"], storageCollectedCents: 0, storageWaivedCents: 0 }),
    ).rejects.toThrow(/Checklist incomplete/);
    const done = await completeHandover(db, {
      showroom,
      unitId: unit.id,
      actor: "staff",
      checklist: HANDOVER_CHECKLIST.map((c) => c.key),
      storageCollectedCents: 0,
      storageWaivedCents: 0,
      now: localToUtc("2026-09-08", "12:30", TZ),
    });
    expect(done.status).toBe("picked_up");
    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.status).toBe("fulfilled");
    const [a] = await db.select().from(appointments).where(eq(appointments.unitId, unit.id));
    expect(a.status).toBe("completed");
    expect(notifier.sent.at(-1)?.metric).toBe("Pickup: Completed");
  });

  it("extension moves both dates by extension_days; second needs admin", async () => {
    const { unit } = await invitedUnit();
    const manager = { id: "m1", role: "manager" } as never;
    const admin = { id: "a1", role: "admin" } as never;
    const once = await grantExtension(db, { showroom, unitId: unit.id, reason: "container delay", user: manager, now: NOW });
    expect(once.bookBy?.toISOString()).toBe(localToUtc("2026-09-22", "23:59:59", TZ).toISOString());
    expect(once.pickupBy?.toISOString()).toBe(localToUtc("2026-09-29", "23:59:59", TZ).toISOString());
    await expect(grantExtension(db, { showroom, unitId: unit.id, reason: "again", user: manager, now: NOW })).rejects.toThrow(/admin/);
    const twice = await grantExtension(db, { showroom, unitId: unit.id, reason: "again", user: admin, now: NOW });
    expect(twice.extensionCount).toBe(2);
    const ev = await db.select().from(events).where(and(eq(events.unitId, unit.id), eq(events.type, "extension_granted")));
    expect(ev).toHaveLength(2);
  });

  it("customer defer cancels the booking without penalty and detaches the unit", async () => {
    const { unit, order } = await invitedUnit();
    const startsAt = localToUtc("2026-09-08", "12:00", TZ);
    await bookSlot(db, { showroom, unitId: unit.id, startsAt, createdBy: "customer", now: NOW });
    const insideCutoff = new Date(startsAt.getTime() - 3_600_000);
    await detachUnit(db, { showroom, unitId: unit.id, reason: "customer_deferred", actor: "customer", now: insideCutoff });
    const [u] = await db.select().from(units).where(eq(units.id, unit.id));
    expect(u.status).toBe("unassigned");
    expect(u.orderId).toBeNull();
    expect(u.noShowCount).toBe(0);
    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.status).toBe("deferred");
    const [a] = await db.select().from(appointments).where(eq(appointments.unitId, unit.id));
    expect(a.status).toBe("cancelled");
    expect(a.cancelledReason).toBe("deferred");
    expect(notifier.sent.at(-1)?.metric).toBe("Pickup: Deferred");
  });

  it("release re-tags a past-book-by unit to a matching waitlist order and re-invites", async () => {
    showroom = await withSettings(db, showroom, { release_rule_enabled: true });
    const { unit, order } = await invitedUnit({ termsVersion: 2 });
    const waiting = await makeOrder(db, showroom, { customerEmail: "next@example.com", orderDate: "2026-08-01" });
    const afterBookBy = localToUtc("2026-09-16", "09:00", TZ);
    await expect(
      retagUnit(db, { showroom, unitId: unit.id, toOrderId: waiting.id, actor: "mgr", reason: "waitlist", customerAgreed: false, now: NOW }),
    ).rejects.toThrow(/book-by/);
    const res = await retagUnit(db, { showroom, unitId: unit.id, toOrderId: waiting.id, actor: "mgr", reason: "waitlist", customerAgreed: false, now: afterBookBy });
    expect(res.unit.status).toBe("invited");
    expect(res.unit.orderId).toBe(waiting.id);
    expect(res.unit.bookBy?.toISOString()).toBe(localToUtc("2026-09-30", "23:59:59", TZ).toISOString());
    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.status).toBe("deferred");
    const metrics = notifier.sent.slice(-2).map((s) => s.metric);
    expect(metrics).toEqual(["Pickup: Deferred", "Pickup: Bike Arrived"]);
    expect(notifier.sent.at(-1)?.profile.email).toBe("next@example.com");
  });

  it("terms v1 release requires customer agreement", async () => {
    showroom = await withSettings(db, showroom, { release_rule_enabled: true });
    const { unit } = await invitedUnit({ termsVersion: 1 });
    const waiting = await makeOrder(db, showroom);
    const afterBookBy = localToUtc("2026-09-16", "09:00", TZ);
    await expect(
      retagUnit(db, { showroom, unitId: unit.id, toOrderId: waiting.id, actor: "mgr", reason: "x", customerAgreed: false, now: afterBookBy }),
    ).rejects.toThrow(/agreement/);
    await expect(
      retagUnit(db, { showroom, unitId: unit.id, toOrderId: waiting.id, actor: "mgr", reason: "x", customerAgreed: true, now: afterBookBy }),
    ).resolves.toBeTruthy();
  });
});

describe("Tier 0 fixes (UX panel 2026-09-03)", () => {
  it("receiving a box for a deferred order reopens it", async () => {
    const { unit, order } = await invitedUnit();
    await detachUnit(db, { showroom, unitId: unit.id, reason: "customer_deferred", actor: "customer", now: NOW });
    let [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.status).toBe("deferred");
    const received = await receiveUnit(db, { showroom, orderId: order.id, boxTag: "NEXT-SHIP-1", actor: "s" });
    expect(received.status).toBe("received");
    [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.status).toBe("open");
    expect(o.deferredAt).toBeNull();
    const trail = await db.select().from(events).where(and(eq(events.orderId, order.id), eq(events.type, "order_reopened")));
    expect(trail).toHaveLength(1);
  });

  it("a deferred order is on the waitlist and an unassigned box can be attached to it", async () => {
    const { unit, order } = await invitedUnit();
    await detachUnit(db, { showroom, unitId: unit.id, reason: "customer_deferred", actor: "customer", now: NOW });
    const { waitlistFor, attachUnit } = await import("@/lib/units");
    const waiting = await waitlistFor(db, showroom.id, unit);
    expect(waiting.map((w) => w.id)).toContain(order.id);
    await attachUnit(db, { showroom, unitId: unit.id, orderId: order.id, actor: "manager-1", now: NOW });
    const [u] = await db.select().from(units).where(eq(units.id, unit.id));
    expect(u.status).toBe("invited");
    expect(u.orderId).toBe(order.id);
    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.status).toBe("open");
  });

  it("box tag is optional: blank defaults to the order reference, with a suffix when taken", async () => {
    const order = await makeOrder(db, showroom, { orderRef: "LS-777" });
    const first = await receiveUnit(db, { showroom, orderId: order.id, boxTag: "  ", actor: "s" });
    expect(first.boxTag).toBe("LS-777");
    // a second order with the same ref from another source → suffix
    const other = await makeOrder(db, showroom, { orderRef: "LS-777", source: "shopify" });
    const second = await receiveUnit(db, { showroom, orderId: other.id, boxTag: "", actor: "s" });
    expect(second.boxTag).toBe("LS-777-2");
    // an explicit duplicate is refused with a readable message
    const third = await makeOrder(db, showroom, { orderRef: "LS-778" });
    await expect(receiveUnit(db, { showroom, orderId: third.id, boxTag: "ls-777", actor: "s" })).rejects.toThrow(/already in use/);
  });

  it("a late reschedule reports lateChange so the customer can be told", async () => {
    const { unit } = await invitedUnit();
    await bookSlot(db, { showroom, unitId: unit.id, startsAt: localToUtc("2026-09-05", "12:30", TZ), createdBy: "customer", now: NOW }); // Saturday slots start 11:00
    const inside = localToUtc("2026-09-04", "20:00", TZ); // 16.5h before → inside the 24h cutoff
    const res = await rescheduleBooking(db, { showroom, unitId: unit.id, startsAt: localToUtc("2026-09-09", "12:00", TZ), actor: "customer", now: inside });
    expect(res.lateChange).toBe(true);
    const [u] = await db.select().from(units).where(eq(units.id, unit.id));
    expect(u.noShowCount).toBe(1);
  });
});

describe("staff booking (Book pickup button)", () => {
  it("silent invite mints the link and starts the clock without the Bike Arrived message", async () => {
    const order = await makeOrder(db, showroom);
    const unit = await makeUnit(db, showroom, order.id);
    const { unit: invited, token } = await inviteUnit(db, { showroom, unitId: unit.id, actor: "staff-1", now: NOW, silent: true });
    expect(invited.status).toBe("invited");
    expect(token).toBeTruthy();
    expect(invited.bookBy).not.toBeNull();
    expect(notifier.sent).toHaveLength(0);
  });

  it("allowShortNotice lets staff book inside the lead time but never in the past", async () => {
    const { unit } = await invitedUnit();
    const soon = localToUtc("2026-09-01", "12:45", TZ); // Tuesday, 2h45m after NOW — inside 48h
    await expect(bookSlot(db, { showroom, unitId: unit.id, startsAt: soon, createdBy: "customer", now: NOW })).rejects.toMatchObject({ code: "TOO_EARLY" });
    const { appointment } = await bookSlot(db, { showroom, unitId: unit.id, startsAt: soon, createdBy: "staff-1", now: NOW, allowShortNotice: true });
    expect(appointment.startsAt.toISOString()).toBe(soon.toISOString());
    expect(notifier.sent.map((s) => s.metric)).toContain("Pickup: Booked");
    const { unit: other } = await invitedUnit();
    await expect(
      bookSlot(db, { showroom, unitId: other.id, startsAt: localToUtc("2026-08-28", "12:00", TZ), createdBy: "staff-1", now: NOW, allowShortNotice: true }),
    ).rejects.toMatchObject({ code: "TOO_EARLY" });
  });
});
