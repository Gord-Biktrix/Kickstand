import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { bookings, events, type BookingType } from "@/db/schema";
import { createBookingType, validateBookingType, WEEKDAY_8_TO_4 } from "@/lib/booking-types";
import { saveConnection, setLightspeedFetch } from "@/lib/lightspeed";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import type { ShowroomCtx } from "@/lib/showroom";
import { localToUtc } from "@/lib/time";
import { cancelTypeBooking, createTypeBooking, rescheduleTypeBooking, syncBookingWorkorder } from "@/lib/type-bookings";
import { makeOrder, resetDb, testDb, withSettings } from "./helpers";

const TZ = "America/Vancouver";
const NOW = localToUtc("2026-11-16", "07:00", TZ);
const slot = (t: string) => localToUtc("2026-11-17", t, TZ);
type Call = { method: string; url: string; body: Record<string, unknown> | null };

function fakeLightspeed(opts: { fail?: boolean } = {}) {
  const calls: Call[] = [];
  let ids = 700;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (opts.fail) return json(500, { message: "down" });
    if (url.endsWith("Customer.json")) return json(200, { Customer: { customerID: String(++ids) } });
    if (url.endsWith("Workorder.json")) return json(200, { Workorder: { workorderID: String(++ids) } });
    if (/Workorder\/\d+\.json$/.test(url)) return json(200, { Workorder: {} });
    return json(404, { message: `unhandled ${method} ${url}` });
  };
  return { calls, fetchImpl };
}

describe("service bookings and Lightspeed work orders", () => {
  let db: Db;
  let van: ShowroomCtx;
  let service: BookingType;
  let ride: BookingType;
  const details = { name: "Pat Mechanic", email: "pat@example.com", phone: "604-555-0144", smsConsent: false, note: "Brakes squeal" };

  beforeAll(async () => {
    db = await testDb();
    process.env.LS_CLIENT_ID ??= "test-client";
    process.env.LS_CLIENT_SECRET ??= "test-secret";
  });
  afterAll(async () => { setLightspeedFetch(null); setNotifier(null); await db.$client.end(); });
  beforeEach(async () => {
    van = await resetDb(db);
    setNotifier(new MemoryNotifier());
    await saveConnection(db, { accountId: "999", accessToken: "acc", refreshToken: "ref", expiresIn: 3600 });
    van = await withSettings(db, van, { lightspeed: { ...van.settings.lightspeed, enabled: true, shop_id: 3, employee_id: 27, open_status_id: 1 } });
    const base = { description: "", location: "in_person" as const, access: "public" as const, durationMin: 60, bufferMin: 0, slotStepMin: 30, noticeMin: 0, horizonDays: 30, capacityMode: "bench" as const, benchCapacity: 2, hours: WEEKDAY_8_TO_4 };
    service = await createBookingType(db, van.id, validateBookingType({ ...base, name: "Service appointment", createsWorkOrder: true }, "showroom"));
    ride = await createBookingType(db, van.id, validateBookingType({ ...base, name: "Test ride", createsWorkOrder: false }, "showroom"));
  });

  it("creates the customer and a work order in the new-work-order status, Due = the appointment", async () => {
    const ls = fakeLightspeed();
    setLightspeedFetch(ls.fetchImpl);
    const { booking } = await createTypeBooking(db, { showroom: van, type: service, startsAt: slot("10:00"), details, createdBy: "customer", now: NOW });
    expect(booking.lsWorkorderId).toBe("702");
    const wo = ls.calls.find((c) => c.method === "POST" && c.url.endsWith("Workorder.json"))!;
    expect(wo.body).toMatchObject({ shopID: 3, customerID: 701, employeeID: 27, workorderStatusID: 1, etaOut: slot("10:00").toISOString(), hookIn: "Service appointment" });
    expect(String(wo.body!.note)).toContain("Customer says: Brakes squeal");
    expect(String(wo.body!.note)).toContain("/book/m/");
  });

  it("reuses the Lightspeed customer of an existing order with the same phone or email", async () => {
    const ls = fakeLightspeed();
    setLightspeedFetch(ls.fetchImpl);
    await makeOrder(db, van, { customerName: "Pat M", customerPhone: "+16045550144", lsCustomerId: "4242" });
    const { booking } = await createTypeBooking(db, { showroom: van, type: service, startsAt: slot("10:00"), details: { ...details, email: "" }, createdBy: "customer", now: NOW });
    expect(ls.calls.some((c) => c.url.endsWith("Customer.json"))).toBe(false);
    expect(ls.calls.find((c) => c.url.endsWith("Workorder.json"))!.body).toMatchObject({ customerID: 4242 });
    const [ev] = await db.select().from(events).where(eq(events.type, "booking_workorder_created"));
    expect(ev.payload).toMatchObject({ booking_id: booking.id, customer_matched: true });
  });

  it("moves Due on reschedule and marks the note cancelled on cancel, never changing the status", async () => {
    const ls = fakeLightspeed();
    setLightspeedFetch(ls.fetchImpl);
    const { booking } = await createTypeBooking(db, { showroom: van, type: service, startsAt: slot("10:00"), details, createdBy: "customer", now: NOW });
    await rescheduleTypeBooking(db, { bookingId: booking.id, startsAt: slot("13:00"), actor: "customer", now: NOW });
    await cancelTypeBooking(db, { bookingId: booking.id, actor: "staff-1", reason: "staff" });
    const puts = ls.calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[0].body).toMatchObject({ etaOut: slot("13:00").toISOString() });
    expect(String(puts[1].body!.note)).toMatch(/^CANCELLED \(by staff\)/);
    expect(puts.every((p) => !("workorderStatusID" in p.body!))).toBe(true);
  });

  it("skips types without the work-order flag and stores with the link off", async () => {
    const ls = fakeLightspeed();
    setLightspeedFetch(ls.fetchImpl);
    await createTypeBooking(db, { showroom: van, type: ride, startsAt: slot("10:00"), details, createdBy: "customer", now: NOW });
    const off = await withSettings(db, van, { lightspeed: { ...van.settings.lightspeed, enabled: false } });
    await createTypeBooking(db, { showroom: off, type: service, startsAt: slot("11:00"), details, createdBy: "customer", now: NOW });
    expect(ls.calls).toHaveLength(0);
  });

  it("keeps the booking when Lightspeed fails; staff retry creates the work order", async () => {
    setLightspeedFetch(fakeLightspeed({ fail: true }).fetchImpl);
    const { booking } = await createTypeBooking(db, { showroom: van, type: service, startsAt: slot("10:00"), details, createdBy: "customer", now: NOW });
    expect(booking.status).toBe("booked");
    expect(booking.lsWorkorderId).toBeNull();
    const [failed] = await db.select().from(events).where(eq(events.type, "booking_workorder_failed"));
    expect(String(failed.payload.error)).toContain("500");
    setLightspeedFetch(fakeLightspeed().fetchImpl);
    const synced = await syncBookingWorkorder(db, { showroom: van, type: service, booking, actor: "staff-1" });
    expect(synced?.lsWorkorderId).toBeTruthy();
    expect((await db.select().from(bookings).where(eq(bookings.id, booking.id)))[0].lsWorkorderId).toBe(synced!.lsWorkorderId);
  });
});
