import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { bookings, events, type BookingType } from "@/db/schema";
import { createBookingType, validateBookingType, WEEKDAY_8_TO_4, type BookingTypeInput } from "@/lib/booking-types";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import { MemorySlack, MemorySlackBot, setSlackBot, setSlackPoster } from "@/lib/slack";
import { getShowroomById, patchShowroomSettings } from "@/lib/showroom";
import { SUGGESTED_CALL_QUESTIONS } from "@/lib/booking-questions";
import type { ShowroomCtx } from "@/lib/showroom";
import { createShowroom } from "@/lib/showroom-admin";
import { localToUtc } from "@/lib/time";
import { BOOKING_METRIC, cancelTypeBooking, cleanDetails, createTypeBooking, getBookingByToken, getBookingDetail, listBookings, rescheduleTypeBooking, resendBookingConfirmation, sendBookingReminders, setBookingOutcome, TypeBookingError } from "@/lib/type-bookings";
import { getTypeAvailability, typeSlots } from "@/lib/type-slots";
import { addClosedDays, bookingsOnClosedDays, listClosedDays, removeClosedDay } from "@/lib/closed-days";
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

  it("offers nothing on a closed day", () => {
    const days = typeSlots({ type: call, tz: TZ, now: NOW, capacity: 1, busy: [], closed: new Set(["2026-11-17"]) });
    expect(days.map((d) => d.date)).not.toContain("2026-11-17");
    expect(days.map((d) => d.date)).toContain("2026-11-18");
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

  it("keeps the booking form's answers and pings the store's Slack channel", async () => {
    const slack = new MemorySlack();
    setSlackPoster(slack);
    try {
      const withQs = await createBookingType(db, online.id, validateBookingType({ ...input, name: "Sales call", questions: SUGGESTED_CALL_QUESTIONS }, "online"));
      const hooked = { ...online, settings: { ...online.settings, slack_webhook_url: "https://hooks.slack.com/services/T/B/x" } };
      const answers = (f: string) => ({ q_topic: "Financing", q_bikes: "" } as Record<string, string>)[f] ?? "";
      await expect(createTypeBooking(db, { showroom: hooked, type: withQs, startsAt: slot("11:00"), details, createdBy: "customer", now: NOW, answers: () => "" })).rejects.toThrow(/Please answer/);
      const { booking } = await createTypeBooking(db, { showroom: hooked, type: withQs, startsAt: slot("11:00"), details, createdBy: "customer", now: NOW, answers });
      expect(booking.answers).toEqual([{ question: "What would you like to talk about?", answer: "Financing" }]);
      expect(notifier.sent.at(-1)!.properties).toMatchObject({ answers: [{ question: "What would you like to talk about?", answer: "Financing" }] });
      expect(slack.posted).toHaveLength(1);
      expect(slack.posted[0].message.text).toContain("New booking: Sales call");
      // No webhook on the store: no ping, booking still fine.
      await createTypeBooking(db, { showroom: online, type: withQs, startsAt: slot("12:00"), details, createdBy: "customer", now: NOW, answers });
      expect(slack.posted).toHaveLength(1);
    } finally {
      setSlackPoster(null);
    }
  });

  it("with the Slack bot, a booking is one message and changes reply in its thread", async () => {
    const bot = new MemorySlackBot();
    const hook = new MemorySlack();
    setSlackBot(bot);
    setSlackPoster(hook);
    try {
      await patchShowroomSettings(db, online.id, { slack_channel_id: "C07TEST01", slack_webhook_url: "https://hooks.slack.com/services/T/B/x" });
      const store = (await getShowroomById(db, online.id))!;
      const { booking } = await createTypeBooking(db, { showroom: store, type, startsAt: slot("10:00"), details, createdBy: "customer", now: NOW });
      expect(bot.posts).toHaveLength(1);
      expect(bot.posts[0]).toMatchObject({ channel: "C07TEST01", threadTs: undefined });
      const [saved] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
      expect(saved).toMatchObject({ slackChannel: "C07TEST01", slackTs: bot.posts[0].ts });

      await rescheduleTypeBooking(db, { bookingId: booking.id, startsAt: slot("10:30"), actor: "customer", now: NOW });
      expect(bot.posts).toHaveLength(2);
      expect(bot.posts[1].threadTs).toBe(bot.posts[0].ts);
      expect(bot.posts[1].message.text).toMatch(/^🔁 Moved to Tuesday 17 November, 10:30 am/);

      await cancelTypeBooking(db, { bookingId: booking.id, actor: "customer", reason: "customer", now: NOW });
      expect(bot.posts[2].threadTs).toBe(bot.posts[0].ts);
      expect(bot.posts[2].message.text).toMatch(/^❌ Cancelled/);
      // The original message is left as posted.
      expect(bot.updates).toHaveLength(0);
      // Nothing went through the webhook while the bot worked.
      expect(hook.posted).toHaveLength(0);

      // The bot failing falls back to the webhook, so the channel still hears about it.
      bot.failNext = 1;
      await createTypeBooking(db, { showroom: store, type, startsAt: slot("11:00"), details, createdBy: "customer", now: NOW });
      expect(hook.posted).toHaveLength(1);
    } finally {
      setSlackBot(undefined);
      setSlackPoster(null);
    }
  });

  it("closed days close the type's calendar and list bookings already on them", async () => {
    const { booking } = await createTypeBooking(db, { showroom: online, type, startsAt: slot("10:00"), details, createdBy: "customer", now: NOW });
    await addClosedDays(db, online.id, [{ date: "2026-11-17", name: "Staff day" }, { date: "2026-11-18", name: "" }]);
    const open = (await getTypeAvailability(db, { showroom: online, type, now: NOW })).map((d) => d.date);
    expect(open).not.toContain("2026-11-17");
    expect(open).not.toContain("2026-11-18");
    expect(open).toContain("2026-11-19");
    const list = await listClosedDays(db, online.id, "2026-11-16");
    expect(list.map((c) => [c.date, c.name])).toEqual([["2026-11-17", "Staff day"], ["2026-11-18", ""]]);
    expect((await bookingsOnClosedDays(db, online.id, ["2026-11-17"])).map((b) => b.id)).toEqual([booking.id]);
    await removeClosedDay(db, online.id, list[0].id);
    expect((await getTypeAvailability(db, { showroom: online, type, now: NOW })).map((d) => d.date)).toContain("2026-11-17");
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

  it("staff can resend the confirmation: a fresh Klaviyo event, no Slack post, only while it's upcoming", async () => {
    const slack = new MemorySlack();
    setSlackPoster(slack);
    await patchShowroomSettings(db, online.id, { slack_webhook_url: "https://hooks.slack.com/services/T/B/x" });
    online = await getShowroomById(db, online.id);
    const { booking } = await createTypeBooking(db, { showroom: online, type, startsAt: slot("10:00"), details, createdBy: "customer", now: NOW });
    const posts = slack.posted.length;
    expect(posts).toBe(1);
    expect(await resendBookingConfirmation(db, { showroomId: online.id, bookingId: booking.id, actor: "staff-1", now: NOW })).toBe("sent");
    expect(notifier.sent.map((s) => s.metric)).toEqual([BOOKING_METRIC.confirmed, BOOKING_METRIC.confirmed]);
    expect(notifier.sent[1].uniqueId).not.toBe(notifier.sent[0].uniqueId);
    expect(notifier.sent[1].properties).toMatchObject({ resent: true, booking_type: "Video call with an expert" });
    expect(slack.posted.length).toBe(posts);
    const [ev] = await db.select().from(events).where(eq(events.type, "booking_confirmation_resent"));
    expect(ev).toMatchObject({ actor: "staff-1", klaviyoStatus: "sent" });
    await expect(resendBookingConfirmation(db, { showroomId: online.id, bookingId: booking.id, actor: "staff-1", now: slot("11:00") })).rejects.toMatchObject({ code: "NOT_ACTIVE" });
    await cancelTypeBooking(db, { bookingId: booking.id, actor: "customer", reason: "customer", now: NOW });
    await expect(resendBookingConfirmation(db, { showroomId: online.id, bookingId: booking.id, actor: "staff-1", now: NOW })).rejects.toMatchObject({ code: "NOT_ACTIVE" });
    setSlackPoster(null);
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

  it("staff see the day's bookings, check people in, mark no-shows and undo; cancelled ones drop off the day", async () => {
    const a = (await createTypeBooking(db, { showroom: online, type, startsAt: slot("10:00"), details, createdBy: "staff-1", now: NOW })).booking;
    const b = (await createTypeBooking(db, { showroom: online, type, startsAt: slot("11:00"), details: { ...details, name: "Alex" }, createdBy: "customer", now: NOW })).booking;
    expect((await listBookings(db, online.id, "2026-11-17", "2026-11-17")).map((r) => r.booking.customerName)).toEqual(["Sam Rider", "Alex"]);
    // Before it starts: check-in is fine (early arrival), a no-show isn't.
    await expect(setBookingOutcome(db, { showroomId: online.id, bookingId: b.id, outcome: "no_show", actor: "staff-1", now: NOW })).rejects.toMatchObject({ code: "TOO_EARLY" });
    await setBookingOutcome(db, { showroomId: online.id, bookingId: a.id, outcome: "completed", actor: "staff-1", now: NOW });
    const later = localToUtc("2026-11-17", "12:00", TZ);
    await setBookingOutcome(db, { showroomId: online.id, bookingId: b.id, outcome: "no_show", actor: "staff-1", now: later });
    await setBookingOutcome(db, { showroomId: online.id, bookingId: b.id, outcome: "booked", actor: "staff-1", now: later });
    await expect(setBookingOutcome(db, { showroomId: online.id, bookingId: b.id, outcome: "booked", actor: "staff-1", now: later })).rejects.toMatchObject({ code: "NOT_ACTIVE" });
    // Done and no-show switch straight to each other (a mis-click), but not to the same status again.
    expect((await setBookingOutcome(db, { showroomId: online.id, bookingId: a.id, outcome: "no_show", actor: "staff-1", now: later })).status).toBe("no_show");
    expect((await setBookingOutcome(db, { showroomId: online.id, bookingId: a.id, outcome: "completed", actor: "staff-1", now: later })).status).toBe("completed");
    await expect(setBookingOutcome(db, { showroomId: online.id, bookingId: a.id, outcome: "completed", actor: "staff-1", now: later })).rejects.toMatchObject({ code: "NOT_ACTIVE" });
    // Another profile can't touch it.
    await expect(setBookingOutcome(db, { showroomId: "00000000-0000-0000-0000-000000000000", bookingId: a.id, outcome: "no_show", actor: "x", now: later })).rejects.toMatchObject({ code: "NOT_ACTIVE" });
    const detail = await getBookingDetail(db, online.id, b.id);
    expect(detail!.timeline.map((e) => e.type)).toEqual(["booking_outcome_undone", "booking_no_show", "booking_confirmed"]);
    expect(await getBookingDetail(db, "00000000-0000-0000-0000-000000000000", b.id)).toBeNull();
    // Outcomes send nothing to Klaviyo.
    expect(notifier.sent.map((s) => s.metric)).toEqual([BOOKING_METRIC.confirmed, BOOKING_METRIC.confirmed]);
    await cancelTypeBooking(db, { bookingId: b.id, actor: "staff-1", reason: "staff" });
    expect((await listBookings(db, online.id, "2026-11-17", "2026-11-17")).map((r) => r.booking.id)).toEqual([a.id]);
    expect((await listBookings(db, online.id, "2026-11-17", "2026-11-17", { includeCancelled: true })).length).toBe(2);
  });
});

describe("day-before booking reminders", () => {
  let db: Db;
  let online: ShowroomCtx;
  let type: BookingType;
  let notifier: MemoryNotifier;
  const slot = (d: string, t: string) => localToUtc(d, t, TZ);
  beforeAll(async () => { db = await testDb(); });
  afterAll(async () => { setNotifier(null); await db.$client.end(); });
  beforeEach(async () => {
    await resetDb(db);
    notifier = new MemoryNotifier();
    setNotifier(notifier);
    online = await createShowroom(db, { slug: "online", name: "Online sales", kind: "online", timezone: TZ, addressLine: "", phone: null });
    type = await createBookingType(db, online.id, validateBookingType({ name: "Phone call with an expert", description: "", location: "phone", access: "public", ...call, capacityMode: "bench", benchCapacity: 1, createsWorkOrder: false }, "online"));
  });

  it("reminds tomorrow's bookings once, again only if moved to a new tomorrow, and never cancelled ones", async () => {
    const d = { name: "Kim", email: "kim@example.com", phone: "", smsConsent: false, note: "" };
    const a = (await createTypeBooking(db, { showroom: online, type, startsAt: slot("2026-11-17", "10:00"), details: d, createdBy: "customer", now: NOW })).booking;
    const b = (await createTypeBooking(db, { showroom: online, type, startsAt: slot("2026-11-17", "11:00"), details: { ...d, name: "Lee" }, createdBy: "customer", now: NOW })).booking;
    await createTypeBooking(db, { showroom: online, type, startsAt: slot("2026-11-18", "10:00"), details: { ...d, name: "Later" }, createdBy: "customer", now: NOW });
    await cancelTypeBooking(db, { bookingId: b.id, actor: "customer", reason: "customer" });
    notifier.sent = [];
    expect(await sendBookingReminders(db, online, "2026-11-17")).toEqual({ sent: 1, failed: 0 });
    expect(notifier.sent.map((s) => [s.metric, s.properties.customer_name])).toEqual([[BOOKING_METRIC.reminder, "Kim"]]);
    expect(await sendBookingReminders(db, online, "2026-11-17")).toEqual({ sent: 0, failed: 0 });
    // Moved to the next day after the reminder: reminded again the day before the new time.
    await rescheduleTypeBooking(db, { bookingId: a.id, startsAt: slot("2026-11-18", "11:00"), actor: "customer", now: NOW });
    expect((await sendBookingReminders(db, online, "2026-11-18")).sent).toBe(2);
    // A failed send is retried on the next tick.
    const c = (await createTypeBooking(db, { showroom: online, type, startsAt: slot("2026-11-19", "10:00"), details: d, createdBy: "customer", now: NOW })).booking;
    notifier.failNext = 1;
    expect(await sendBookingReminders(db, online, "2026-11-19")).toEqual({ sent: 0, failed: 1 });
    expect(await sendBookingReminders(db, online, "2026-11-19")).toEqual({ sent: 1, failed: 0 });
    expect(c.status).toBe("booked");
  });
});
