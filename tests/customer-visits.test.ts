import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import type { BookingType } from "@/db/schema";
import { createBookingType, validateBookingType, WEEKDAY_8_TO_4 } from "@/lib/booking-types";
import { bookingCustomerKey, customerProfile, searchCustomers } from "@/lib/customers";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import type { ShowroomCtx } from "@/lib/showroom";
import { localToUtc } from "@/lib/time";
import { createTypeBooking } from "@/lib/type-bookings";
import { makeOrder, resetDb, testDb } from "./helpers";

const TZ = "America/Vancouver";
const NOW = localToUtc("2026-11-16", "07:00", TZ);

describe("customers include their bookings", () => {
  let db: Db;
  let van: ShowroomCtx;
  let ride: BookingType;
  beforeAll(async () => { db = await testDb(); });
  afterAll(async () => { setNotifier(null); await db.$client.end(); });
  beforeEach(async () => {
    van = await resetDb(db);
    setNotifier(new MemoryNotifier());
    ride = await createBookingType(db, van.id, validateBookingType({ name: "Test ride", description: "", location: "in_person", access: "public", durationMin: 45, bufferMin: 0, slotStepMin: 15, noticeMin: 0, horizonDays: 30, capacityMode: "bench", benchCapacity: 3, hours: WEEKDAY_8_TO_4, createsWorkOrder: false }, "showroom"));
  });

  it("a buyer's page lists their test rides, matched by phone across formats", async () => {
    const order = await makeOrder(db, van, { customerName: "Maya Chen", customerPhone: "604-555-0182", customerEmail: null });
    await createTypeBooking(db, { showroom: van, type: ride, startsAt: localToUtc("2026-11-17", "10:00", TZ), details: { name: "Maya C", email: "", phone: "+1 (604) 555 0182", smsConsent: false, note: "" }, createdBy: "customer", now: NOW });
    const profile = await customerProfile(db, van, "ph:6045550182");
    expect(profile!.orders.map((o) => o.id)).toEqual([order.id]);
    expect(profile!.visits.map((v) => v.type.name)).toEqual(["Test ride"]);
  });

  it("someone who only booked has a page and shows up in search", async () => {
    const { booking } = await createTypeBooking(db, { showroom: van, type: ride, startsAt: localToUtc("2026-11-17", "11:00", TZ), details: { name: "Lena Ruiz", email: "lena@example.com", phone: "", smsConsent: false, note: "" }, createdBy: "customer", now: NOW });
    const key = bookingCustomerKey(booking);
    expect(key).toBe("em:lena@example.com");
    const profile = await customerProfile(db, van, key);
    expect(profile).toMatchObject({ name: "Lena Ruiz", orders: [], email: "lena@example.com" });
    expect(profile!.visits).toHaveLength(1);
    const hits = await searchCustomers(db, van, "lena");
    expect(hits.map((h) => [h.key, h.visits, h.orders.length])).toEqual([["em:lena@example.com", 1, 0]]);
  });

  it("search adds bookings to the buyer instead of listing them twice", async () => {
    await makeOrder(db, van, { customerName: "Tom Becker", customerPhone: "+16045550111" });
    await createTypeBooking(db, { showroom: van, type: ride, startsAt: localToUtc("2026-11-17", "12:00", TZ), details: { name: "Tom Becker", email: "", phone: "6045550111", smsConsent: false, note: "" }, createdBy: "customer", now: NOW });
    const hits = await searchCustomers(db, van, "becker");
    expect(hits).toHaveLength(1);
    expect(hits[0].visits).toBe(1);
    expect(hits[0].orders).toHaveLength(1);
  });
});
