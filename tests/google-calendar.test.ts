import { generateKeyPairSync, createVerify } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { bookings, events, showrooms, type BookingType } from "@/db/schema";
import { createBookingType, validateBookingType, WEEKDAY_8_TO_4 } from "@/lib/booking-types";
import { GoogleCalendarWriter, setCalendarWriter, signedAssertion, type CalendarEvent, type CalendarWriter } from "@/lib/google-calendar";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import { getShowroomById, type ShowroomCtx } from "@/lib/showroom";
import { updateShowroomDetails } from "@/lib/showroom-admin";
import { localToUtc } from "@/lib/time";
import { cancelTypeBooking, createTypeBooking, rescheduleTypeBooking } from "@/lib/type-bookings";
import { resetDb, testDb } from "./helpers";

const TZ = "America/Vancouver";
const NOW = localToUtc("2026-11-16", "07:00", TZ);
const slot = (t: string) => localToUtc("2026-11-17", t, TZ);

class FakeCalendar implements CalendarWriter {
  events = new Map<string, { calendarId: string; event: CalendarEvent }>();
  log: string[] = [];
  fail = false;
  private n = 0;
  async upsert(calendarId: string, eventId: string | null, event: CalendarEvent) {
    if (this.fail) throw new Error("Google Calendar POST 404");
    const id = eventId ?? `ev${++this.n}`;
    this.log.push(`${eventId ? "patch" : "insert"} ${calendarId} ${id}`);
    this.events.set(id, { calendarId, event });
    return id;
  }
  async remove(calendarId: string, eventId: string) {
    this.log.push(`delete ${calendarId} ${eventId}`);
    this.events.delete(eventId);
  }
}

describe("service account token", () => {
  it("signs an RS256 assertion Google can verify, and exchanges it for a token", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sa = { client_email: "kickstand@proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    const jwt = signedAssertion(sa, 1_800_000_000);
    const [h, c, sig] = jwt.split(".");
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    expect(claims).toMatchObject({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/calendar.events", exp: 1_800_003_600 });
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(`${init?.method} ${String(input)}`);
      if (String(input).includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      return new Response(JSON.stringify({ id: "abc" }));
    };
    const w = new GoogleCalendarWriter(sa, fetchImpl);
    expect(await w.upsert("cal@group.calendar.google.com", null, { summary: "x", description: "", location: "", start: new Date(), end: new Date(), timeZone: TZ })).toBe("abc");
    expect(calls).toEqual(["POST https://oauth2.googleapis.com/token", "POST https://www.googleapis.com/calendar/v3/calendars/cal%40group.calendar.google.com/events"]);
  });
});

describe("bookings on the store's Google Calendar", () => {
  let db: Db;
  let van: ShowroomCtx;
  let type: BookingType;
  let cal: FakeCalendar;
  const details = { name: "Robin", email: "robin@example.com", phone: "", smsConsent: false, note: "First e-bike" };

  beforeAll(async () => { db = await testDb(); });
  afterAll(async () => { setCalendarWriter(undefined); setNotifier(null); await db.$client.end(); });
  beforeEach(async () => {
    van = await resetDb(db);
    setNotifier(new MemoryNotifier());
    cal = new FakeCalendar();
    setCalendarWriter(cal);
    await updateShowroomDetails(db, van.id, { name: van.name, timezone: van.timezone, addressLine: van.addressLine, phone: van.phone, googleCalendarId: "van@group.calendar.google.com" });
    van = await getShowroomById(db, van.id);
    type = await createBookingType(db, van.id, validateBookingType({ name: "Test ride", description: "", location: "in_person", access: "public", durationMin: 45, bufferMin: 0, slotStepMin: 15, noticeMin: 0, horizonDays: 30, capacityMode: "bench", benchCapacity: 2, hours: WEEKDAY_8_TO_4, createsWorkOrder: false }, "showroom"));
  });

  it("creates, moves and deletes the event with the booking", async () => {
    const { booking } = await createTypeBooking(db, { showroom: van, type, startsAt: slot("10:00"), details, createdBy: "customer", now: NOW });
    const ev = [...cal.events.values()][0];
    expect(ev.calendarId).toBe("van@group.calendar.google.com");
    expect(ev.event).toMatchObject({ summary: "Test ride · Robin", location: van.addressLine, start: slot("10:00"), timeZone: TZ });
    expect(ev.event.description).toContain("/app/bookings/");
    await rescheduleTypeBooking(db, { bookingId: booking.id, startsAt: slot("11:00"), actor: "customer", now: NOW });
    expect([...cal.events.values()][0].event.start).toEqual(slot("11:00"));
    await cancelTypeBooking(db, { bookingId: booking.id, actor: "customer", reason: "customer" });
    expect(cal.events.size).toBe(0);
    expect(cal.log).toEqual(["insert van@group.calendar.google.com ev1", "patch van@group.calendar.google.com ev1", "delete van@group.calendar.google.com ev1"]);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row.googleEventId).toBeNull();
  });

  it("does nothing without a calendar id, and a Google failure never blocks the booking", async () => {
    await db.update(showrooms).set({ googleCalendarId: null }).where(eq(showrooms.id, van.id));
    const plain = await getShowroomById(db, van.id);
    await createTypeBooking(db, { showroom: plain, type, startsAt: slot("10:00"), details, createdBy: "customer", now: NOW });
    expect(cal.log).toEqual([]);
    cal.fail = true;
    const { booking } = await createTypeBooking(db, { showroom: van, type, startsAt: slot("12:00"), details, createdBy: "customer", now: NOW });
    expect(booking.status).toBe("booked");
    const [ev] = await db.select().from(events).where(eq(events.type, "booking_calendar_failed"));
    expect(String(ev.payload.error)).toContain("404");
    await expect(updateShowroomDetails(db, van.id, { name: van.name, timezone: van.timezone, addressLine: "", phone: null, googleCalendarId: "not a calendar" })).rejects.toThrow(/Calendar id/);
  });
});
