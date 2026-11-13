import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { bookings, events, type BookingType } from "@/db/schema";
import { createBookingType, validateBookingType, WEEKDAY_8_TO_4, type BookingTypeInput } from "@/lib/booking-types";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import type { ShowroomCtx } from "@/lib/showroom";
import { createShowroom } from "@/lib/showroom-admin";
import { localToUtc } from "@/lib/time";
import { BOOKING_METRIC, cancelTypeBooking, cleanDetails, createTypeBooking, getBookingByToken, rescheduleTypeBooking, TypeBookingError } from "@/lib/type-bookings";
import { getTypeAvailability, typeSlots } from "@/lib/type-slots";
import { resetDb, testDb } from "./helpers";

const TZ = "America/Vancouver";
// Monday 2026-11-16, 07:00 Pacific.
const NOW = localToUtc("2026-11-16", "07:00", TZ);
const call = { durationMin: 30, bufferMin: 0, slotStepMin: 30, noticeMin: 240, horizonDays: 14, hours: WEEKDAY_8_TO_4 };

describe("typeSlots", () => {
  it("cuts the hours into starts that fit, after the notice, within the horizon", () => {
    const days = typeSlots({ type: call, tz: TZ, now: NOW, capacity: 1, busy: [] });
    // 4h notice from 07:00 → first start 11:00; last start 15:30 so the call ends by 16:00.
    expect(days[0].date).toBe("2026-11-16");
    expect(days[0].slots.map((s) => s.time)).toEqual(["11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30"]);
    expect(days[1].slots[0].time).toBe("08:00");
    // Weekends closed; horizon 14 days → last day 2026-11-30 (a Monday).
    expect(days.some((d) => d.date === "2026-11-21")).toBe(false);
    expect(days.at(-1)!.date).toBe("2026-11-30");
  });

  it("counts overlapping bookings, buffer included, against capacity", () => {
    const at = (t: string) => localToUtc("2026-11-17", t, TZ);
    const busy = [{ startsAt: at("09:00"), endsAt: at("09:30") }];
    const tue = (cap: number, buffer = 0) => typeSlots({ type: { ...call, bufferMin: buffer }, tz: TZ, now: NOW, capacity: cap, busy, from: "2026-11-17", to: "2026-11-17" })[0].slots.map((s) => s.time);
    expect(tue(1)).not.toContain("09:00");
    expect(tue(1)).toContain("09:30");
    expect(tue(2)).toContain("09:00");
    // A 15-minute buffer after the 9:00 booking also blocks 9:30.
    expect(tue(1, 15)).not.toContain("09:30");
    expect(tue(1, 15)).toContain("10:00");
  });
});

describe("booking a booking type", () => {
  let db: Db;
  let online: ShowroomCtx;
  let type: BookingType;
  let notifier: MemoryNotifier;
  const input: BookingTypeInput = { name: "Video call with an expert", description: "", location: "video", access: "public", ...call, capacityMode: "bench", benchCapacity: 1, createsWorkOrder: false };
  const details = { name: "Sam Rider", email: "sam@example.com", phone: "604 555 0101", smsConsent: true, note: "Interested in the Juggernaut" };
  const slot = (t: string) => localToUtc("2026-11-17", t, TZ);

  beforeAll(async () => { db = await testDb(); });
  afterAll(async () => { setNotifier(null); await db.$client.end(); });
  beforeEach(async () => {
    await resetDb(db);
    notifier = new MemoryNotifier();
    setNotifier(notifier);
    online = await createShowroom(db, { slug: "online", name: "Online sales", kind: "online", timezone: TZ, addressLine: "", phone: null });
    type = await createBookingType(db, online.id, validateBookingType(input, "online"));
  });

  it("checks the customer's details", () => {
    expect(cleanDetails(details)).toMatchObject({ name: "Sam Rider", phone: "+16045550101", smsConsent: true });
    expect(cleanDetails({ ...details, phone: "" }).smsConsent).toBe(false);
    expect(() => cleanDetails({ ...details, email: "", phone: "" })).toThrow(/email or a phone/);
    expect(() => cleanDetails({ ...details, email: "nope" })).toThrow(/email/);
    expect(() => cleanDetails({ ...details, name: " " })).toThrow(/name/);
  });

  it("books a slot once, sends Booking: Confirmed with the manage link, and the slot disappears", async () => {
    const { booking, token } = await createTypeBooking(db, { showroom: online, type, startsAt: slot("10:00"), details, createdBy: "customer", now: NOW });
    expect(booking.status).toBe("booked");
    expect((await getBookingByToken(db, token))!.booking.id).toBe(booking.id);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0].metric).toBe(BOOKING_METRIC.confirmed);
    expect(notifier.sent[0].properties).toMatchObject({ booking_type: "Video call with an expert", location_kind: "video", time_display: "10:00 am – 10:30 am" });
    expect(String(notifier.sent[0].properties.manage_url)).toContain(`/book/m/${token}`);
    const days = await getTypeAvailability(db, { showroom: online, type, now: NOW, from: "2026-11-17", to: "2026-11-17" });
    expect(days[0].slots.map((s) => s.time)).not.toContain("10:00");
    await expect(createTypeBooking(db, { showroom: online, type, startsAt: slot("10:00"), details, createdBy: "customer", now: NOW })).rejects.toMatchObject({ code: "SLOT_TAKEN" });
    // A time that isn't on the grid is refused too.
    await expect(createTypeBooking(db, { showroom: online, type, startsAt: slot("10:10"), details, createdBy: "customer", now: NOW })).rejects.toBeInstanceOf(TypeBookingError);
    const [ev] = await db.select().from(events).where(eq(events.type, "booking_confirmed"));
    expect(ev.klaviyoStatus).toBe("sent");
  });

  it("two customers racing for the last place: exactly one gets it", async () => {
    const results = await Promise.allSettled([1, 2, 3].map((i) => createTypeBooking(db, { showroom: online, type, startsAt: slot("11:00"), details: { ...details, name: `Racer ${i}` }, createdBy: "customer", now: NOW })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await db.select().from(bookings)).length).toBe(1);
  });

  it("reschedules (own slot doesn't block the move) and cancels, each with its own event", async () => {
    const { booking } = await createTypeBooking(db, { showroom: online, type, startsAt: slot("10:00"), details, createdBy: "customer", now: NOW });
    const moved = await rescheduleTypeBooking(db, { bookingId: booking.id, startsAt: slot("10:30"), actor: "customer", now: NOW });
    expect(moved.startsAt.toISOString()).toBe(slot("10:30").toISOString());
    expect(moved.rescheduleCount).toBe(1);
    const cancelled = await cancelTypeBooking(db, { bookingId: booking.id, actor: "customer", reason: "customer", now: NOW });
    expect(cancelled.status).toBe("cancelled");
    await expect(cancelTypeBooking(db, { bookingId: booking.id, actor: "customer", reason: "customer" })).rejects.toMatchObject({ code: "NOT_ACTIVE" });
    expect(notifier.sent.map((s) => s.metric)).toEqual([BOOKING_METRIC.confirmed, BOOKING_METRIC.rescheduled, BOOKING_METRIC.cancelled]);
    expect(new Set(notifier.sent.map((s) => s.uniqueId)).size).toBe(3);
  });

  it("keeps the booking when Klaviyo fails, and marks the event failed", async () => {
    notifier.failNext = 1;
    const { booking } = await createTypeBooking(db, { showroom: online, type, startsAt: slot("12:00"), details, createdBy: "customer", now: NOW });
    expect(booking.status).toBe("booked");
    const [ev] = await db.select().from(events).where(eq(events.type, "booking_confirmed"));
    expect(ev.klaviyoStatus).toBe("failed");
  });

  it("refuses invite-only and switched-off types from the public page, and the pickup type always", async () => {
    const invite = await createBookingType(db, online.id, validateBookingType({ ...input, name: "VIP call", access: "invite" }, "online"));
    await expect(createTypeBooking(db, { showroom: online, type: invite, startsAt: slot("10:00"), details, createdBy: "customer", now: NOW })).rejects.toMatchObject({ code: "NOT_BOOKABLE" });
    await expect(createTypeBooking(db, { showroom: online, type: { ...type, active: false }, startsAt: slot("10:00"), details, createdBy: "customer", now: NOW })).rejects.toMatchObject({ code: "NOT_BOOKABLE" });
    await expect(createTypeBooking(db, { showroom: online, type: { ...type, kind: "pickup" }, startsAt: slot("10:00"), details, createdBy: "customer", now: NOW })).rejects.toMatchObject({ code: "NOT_BOOKABLE" });
  });
});
