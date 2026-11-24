import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { bookings, events, lsWorkorders, lsWorkorderStatuses, type BookingType } from "@/db/schema";
import { createBookingType, validateBookingType, WEEKDAY_8_TO_4 } from "@/lib/booking-types";
import { saveConnection, setLightspeedFetch } from "@/lib/lightspeed";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import type { ShowroomCtx } from "@/lib/showroom";
import { localToUtc } from "@/lib/time";
import { cancelTypeBooking, createTypeBooking, rescheduleTypeBooking, setBookingOutcome, syncBookingWorkorder } from "@/lib/type-bookings";
import { makeOrder, resetDb, testDb, withSettings } from "./helpers";

const TZ = "America/Vancouver";
const NOW = localToUtc("2027-11-15", "07:00", TZ);
const slot = (t: string) => localToUtc("2027-11-16", t, TZ);
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
    if (/Workorder\/\d+\/WorkorderItem\.json$/.test(url)) return json(200, { WorkorderItem: { workorderItemID: String(++ids) } });
    if (/Workorder\/\d+\.json$/.test(url)) return json(200, { Workorder: {} });
    if (/Customer\/\d+\.json/.test(url)) return json(200, { Customer: { customerID: "9020", firstName: "Walk", lastName: "In", Contact: { Emails: { ContactEmail: { address: "walk@example.com" } }, Phones: { ContactPhone: { number: "604-555-0100", useType: "Mobile" } } } } });
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
    await db.delete(lsWorkorderStatuses); // account-wide, so other test files can leave some behind
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

  it("moves Due on reschedule; on cancel marks the note cancelled and archives the work order", async () => {
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
    const del = ls.calls.filter((c) => c.method === "DELETE");
    expect(del.map((c) => c.url.split("/").at(-1))).toEqual([`${booking.lsWorkorderId}.json`]);
    expect(await db.select().from(events).where(eq(events.type, "booking_workorder_archived"))).toHaveLength(1);
  });

  it("books into the shop's Appointment status; check in moves it to Open with today's date in; undo puts it back", async () => {
    await db.insert(lsWorkorderStatuses).values([{ id: 1, name: "Open", systemValue: "open" }, { id: 27, name: "Appointment", systemValue: null }]);
    const ls = fakeLightspeed();
    setLightspeedFetch(ls.fetchImpl);
    const { booking } = await createTypeBooking(db, { showroom: van, type: service, startsAt: slot("10:00"), details, createdBy: "customer", now: NOW });
    expect(ls.calls.find((c) => c.method === "POST" && c.url.endsWith("Workorder.json"))!.body).toMatchObject({ workorderStatusID: 27 });
    const at = localToUtc("2027-11-16", "09:55", TZ);
    await setBookingOutcome(db, { showroomId: van.id, bookingId: booking.id, outcome: "completed", actor: "staff-1", now: at });
    const checkIn = ls.calls.filter((c) => c.method === "PUT").at(-1)!;
    expect(checkIn.body).toEqual({ workorderStatusID: 1, timeIn: at.toISOString() });
    await setBookingOutcome(db, { showroomId: van.id, bookingId: booking.id, outcome: "booked", actor: "staff-1", now: at });
    expect(ls.calls.filter((c) => c.method === "PUT").at(-1)!.body).toEqual({ workorderStatusID: 27 });
  });

  it("a checked-in booking's job page opens before the hourly sync has seen its work order", async () => {
    const { workshopJobs } = await import("@/lib/workshop");
    await db.insert(lsWorkorderStatuses).values([{ id: 1, name: "Open", systemValue: "open" }, { id: 27, name: "Appointment", systemValue: null }]);
    setLightspeedFetch(fakeLightspeed().fetchImpl);
    const { booking } = await createTypeBooking(db, { showroom: van, type: service, startsAt: slot("10:00"), details, createdBy: "customer", now: NOW });
    const [made] = await db.select().from(lsWorkorders).where(eq(lsWorkorders.id, booking.lsWorkorderId!));
    expect(made).toMatchObject({ statusId: 27, customerName: "Pat Mechanic" });
    // Kickstand's copy lost it (made before this fix, say): check in puts it back.
    await db.delete(lsWorkorders);
    const at = localToUtc("2027-11-16", "09:55", TZ);
    await setBookingOutcome(db, { showroomId: van.id, bookingId: booking.id, outcome: "completed", actor: "staff-1", now: at });
    const jobs = await workshopJobs(db, van, at);
    expect(jobs.find((j) => j.id === `b:${booking.id}`)).toMatchObject({ workorderId: booking.lsWorkorderId, notHereYet: false });
  });

  it("a booking scheduled from New ticket uses the Lightspeed customer and bike already picked", async () => {
    const ls = fakeLightspeed();
    setLightspeedFetch(ls.fetchImpl);
    await createTypeBooking(db, { showroom: van, type: service, startsAt: slot("10:00"), details, createdBy: "staff-1", now: NOW, lsCustomerId: "9020", lsSerializedId: "501" });
    expect(ls.calls.some((c) => c.method === "POST" && c.url.endsWith("Customer.json"))).toBe(false);
    expect(ls.calls.find((c) => c.method === "POST" && c.url.endsWith("Workorder.json"))!.body).toMatchObject({ customerID: 9020, serializedID: 501 });
  });

  it("a ticket for later books the drop-off, then puts its services and parts on the booking's work order", async () => {
    const { scheduleTicket } = await import("@/lib/tickets");
    const ls = fakeLightspeed();
    setLightspeedFetch(ls.fetchImpl);
    const r = await scheduleTicket(db, {
      showroom: van, type: service, startsAt: slot("10:00"), smsConsent: false, actor: "staff-1", now: NOW,
      customer: { lsCustomerId: "9020", name: "Alan Uyeno", phone: "604-916-8336", email: "alan@example.com" },
      bike: "Kutty X 2 Yellow", serial: "S022YP01561", serializedId: "503", service: "Tune Up", said: "Squeaks", employeeId: null,
      parts: [{ itemId: "77", name: "Tune Up", qty: 1 }, { itemId: "55", name: "Brake pads", qty: 2 }], photos: [],
    });
    expect(r.workorderId).toBeTruthy();
    expect(r).toMatchObject({ partsAdded: 2, partsFailed: [] });
    const wo = ls.calls.find((c) => c.method === "POST" && c.url.endsWith("Workorder.json"))!;
    expect(wo.body).toMatchObject({ customerID: 9020, serializedID: 503 });
    expect(String(wo.body!.note)).toContain("Customer says: Tune Up. Squeaks");
    expect(ls.calls.filter((c) => /Workorder\/\d+\/WorkorderItem\.json$/.test(c.url)).map((c) => [c.body!.workorderID, c.body!.itemID, c.body!.unitQuantity])).toEqual([[Number(r.workorderId), 77, 1], [Number(r.workorderId), 55, 2]]);
    const [b] = await db.select().from(bookings).where(eq(bookings.id, r.bookingId));
    expect(b).toMatchObject({ customerName: "Alan Uyeno", status: "booked" });
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
