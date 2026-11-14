/**
 * Customers booking a standard booking type (test ride, service, video call…) from a profile's public
 * booking page, plus reschedule and cancel from the manage link. Bike pickups keep their own flow
 * (booking.ts). Each confirmed change fires one Klaviyo event ("Booking: Confirmed" / "Rescheduled" /
 * "Cancelled"); the flow in Klaviyo owns the wording and channel, as for pickups.
 */
import { and, asc, between, desc, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { bookingSlackMessage, postSlack, type BookingSlackPing } from "./slack";
import { collectAnswers, readAnswers, readQuestions } from "./booking-questions";
import type { Db, DbOrTx } from "@/db/client";
import { bookings, bookingTypes, events, orders, type Booking, type BookingType } from "@/db/schema";
import { formatInTimeZone } from "date-fns-tz";
import { LightspeedClient, lightspeedEnabled } from "./lightspeed";
import { getCalendarWriter } from "./google-calendar";
import { LOCATION_LABEL, type BookingLocation } from "./booking-types";
import { logger } from "./logger";
import { baseUrl } from "./messages";
import { getNotifier } from "./notifier";
import { normalizePhone } from "./phone";
import { getShowroomById, type ShowroomCtx } from "./showroom";
import { findSlot, getTypeAvailability } from "./type-slots";
import { formatLongDate, formatTime, toLocalDate } from "./time";
import { decryptToken, encryptToken, generateToken, hashToken } from "./tokens";

export const BOOKING_METRIC = {
  confirmed: "Booking: Confirmed",
  rescheduled: "Booking: Rescheduled",
  cancelled: "Booking: Cancelled",
  reminder: "Booking: Reminder Day Before",
} as const;

export type TypeBookingErrorCode = "SLOT_TAKEN" | "INVALID_SLOT" | "NOT_BOOKABLE" | "NOT_ACTIVE" | "DETAILS" | "TOO_EARLY";

export const TYPE_BOOKING_ERROR_TEXT: Record<TypeBookingErrorCode, string> = {
  SLOT_TAKEN: "Someone just booked that time. Please pick another.",
  INVALID_SLOT: "That time isn't available. Please pick another.",
  NOT_BOOKABLE: "This appointment can't be booked online.",
  NOT_ACTIVE: "This booking has already been cancelled or has passed.",
  DETAILS: "Please check your details.",
  TOO_EARLY: "That appointment hasn't started yet.",
};

export class TypeBookingError extends Error {
  constructor(public code: TypeBookingErrorCode, message?: string) {
    super(message ?? TYPE_BOOKING_ERROR_TEXT[code]);
  }
}

export type CustomerDetails = { name: string; email: string; phone: string; smsConsent: boolean; note: string };

/** Name plus at least one way to reach them; the phone stored in E.164. Throws TypeBookingError("DETAILS"). */
export function cleanDetails(d: CustomerDetails): { name: string; email: string | null; phone: string | null; smsConsent: boolean; note: string } {
  const name = d.name.trim();
  if (!name) throw new TypeBookingError("DETAILS", "Please enter your name.");
  const email = d.email.trim().toLowerCase() || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new TypeBookingError("DETAILS", "That email address doesn't look right.");
  const phone = d.phone.trim() ? normalizePhone(d.phone) : null;
  if (d.phone.trim() && !phone) throw new TypeBookingError("DETAILS", "That phone number doesn't look right.");
  if (!email && !phone) throw new TypeBookingError("DETAILS", "Please give an email or a phone number so we can confirm.");
  return { name: name.slice(0, 120), email, phone, smsConsent: !!phone && d.smsConsent, note: d.note.trim().slice(0, 1000) };
}

/** Serialise bookings per type so two customers can't take the last place at the same moment. */
async function lockType(tx: DbOrTx, typeId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"booking_type:" + typeId}))`);
}

export function bookingUrls(b: Pick<Booking, "tokenEnc">) {
  const token = decryptToken(b.tokenEnc);
  const manage = `${baseUrl()}/book/m/${token}`;
  return { manage_url: manage, reschedule_url: `${manage}/reschedule`, ics_url: `${manage}/ics` };
}

export async function getBookingByToken(dbx: DbOrTx, token: string): Promise<{ booking: Booking; type: BookingType; showroom: ShowroomCtx } | null> {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const [row] = await dbx
    .select({ booking: bookings, type: bookingTypes })
    .from(bookings)
    .innerJoin(bookingTypes, eq(bookingTypes.id, bookings.bookingTypeId))
    .where(eq(bookings.tokenHash, hashToken(token)))
    .limit(1);
  if (!row) return null;
  return { ...row, showroom: await getShowroomById(dbx, row.booking.showroomId) };
}

export async function createTypeBooking(
  db: Db,
  args: { showroom: ShowroomCtx; type: BookingType; startsAt: Date; details: CustomerDetails; createdBy: string; now?: Date; answers?: (field: string) => string },
): Promise<{ booking: Booking; token: string }> {
  const { showroom, type } = args;
  if (type.kind !== "standard" || type.showroomId !== showroom.id) throw new TypeBookingError("NOT_BOOKABLE");
  if (!type.active || (type.access !== "public" && args.createdBy === "customer")) throw new TypeBookingError("NOT_BOOKABLE");
  const details = cleanDetails(args.details);
  const answers = collectAnswers(readQuestions(type.questions), args.answers ?? (() => ""), (m) => {
    throw new TypeBookingError("DETAILS", m);
  });
  const token = generateToken();
  const booking = await db.transaction(async (tx) => {
    await lockType(tx, type.id);
    const days = await getTypeAvailability(tx, { showroom, type, now: args.now, from: toLocalDate(args.startsAt, showroom.timezone), to: toLocalDate(args.startsAt, showroom.timezone) });
    const slot = findSlot(days, args.startsAt);
    if (!slot) throw new TypeBookingError("SLOT_TAKEN");
    const [row] = await tx
      .insert(bookings)
      .values({
        showroomId: showroom.id,
        bookingTypeId: type.id,
        onDate: toLocalDate(slot.startsAt, showroom.timezone),
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        customerName: details.name,
        customerEmail: details.email,
        customerPhone: details.phone,
        smsConsent: details.smsConsent,
        customerNote: details.note,
        answers,
        tokenHash: hashToken(token),
        tokenEnc: encryptToken(token),
        createdBy: args.createdBy,
      })
      .returning();
    return row;
  });
  await notifyBooking(db, { showroom, type, booking, metric: BOOKING_METRIC.confirmed, actor: args.createdBy });
  const synced = await syncBookingWorkorder(db, { showroom, type, booking, actor: args.createdBy });
  await syncBookingCalendar(db, { showroom, type, bookingId: booking.id, actor: args.createdBy });
  return { booking: synced ?? booking, token };
}

export async function rescheduleTypeBooking(
  db: Db,
  args: { bookingId: string; startsAt: Date; actor: string; now?: Date },
): Promise<Booking> {
  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(bookings).where(eq(bookings.id, args.bookingId));
    if (!current) throw new TypeBookingError("NOT_ACTIVE");
    const now = args.now ?? new Date();
    if (current.status !== "booked" || current.startsAt <= now) throw new TypeBookingError("NOT_ACTIVE");
    const [type] = await tx.select().from(bookingTypes).where(eq(bookingTypes.id, current.bookingTypeId));
    const showroom = await getShowroomById(tx, current.showroomId);
    await lockType(tx, type.id);
    const day = toLocalDate(args.startsAt, showroom.timezone);
    const days = await getTypeAvailability(tx, { showroom, type, now, from: day, to: day, exceptBookingId: current.id });
    const slot = findSlot(days, args.startsAt);
    if (!slot) throw new TypeBookingError("SLOT_TAKEN");
    const [row] = await tx
      .update(bookings)
      .set({ startsAt: slot.startsAt, endsAt: slot.endsAt, onDate: day, rescheduleCount: current.rescheduleCount + 1 })
      .where(eq(bookings.id, current.id))
      .returning();
    return { booking: row, type, showroom, from: current.startsAt };
  });
  await notifyBooking(db, { ...result, metric: BOOKING_METRIC.rescheduled, actor: args.actor, extra: { previous_display: `${formatLongDate(result.from, result.showroom.timezone)} at ${formatTime(result.from, result.showroom.timezone)}` } });
  await syncBookingWorkorder(db, { ...result, actor: args.actor });
  await syncBookingCalendar(db, { showroom: result.showroom, type: result.type, bookingId: result.booking.id, actor: args.actor });
  return result.booking;
}

export async function cancelTypeBooking(db: Db, args: { bookingId: string; actor: string; reason: string; now?: Date }): Promise<Booking> {
  const [current] = await db.select().from(bookings).where(eq(bookings.id, args.bookingId));
  if (!current || current.status !== "booked") throw new TypeBookingError("NOT_ACTIVE");
  const [row] = await db.update(bookings).set({ status: "cancelled", cancelledReason: args.reason }).where(eq(bookings.id, current.id)).returning();
  const [type] = await db.select().from(bookingTypes).where(eq(bookingTypes.id, current.bookingTypeId));
  const showroom = await getShowroomById(db, current.showroomId);
  await notifyBooking(db, { showroom, type, booking: row, metric: BOOKING_METRIC.cancelled, actor: args.actor });
  await syncBookingWorkorder(db, { showroom, type, booking: row, actor: args.actor });
  await syncBookingCalendar(db, { showroom, type, bookingId: row.id, actor: args.actor });
  return row;
}

const SLACK_KIND: Record<string, BookingSlackPing["kind"]> = {
  [BOOKING_METRIC.confirmed]: "new",
  [BOOKING_METRIC.rescheduled]: "rescheduled",
  [BOOKING_METRIC.cancelled]: "cancelled",
};

/** Tell the store's Slack channel (Settings › Program › Slack) about a booking made, moved or cancelled. Never throws. */
async function pingSlack(showroom: ShowroomCtx, type: BookingType, b: Booking, metric: string, extra?: Record<string, unknown>) {
  const kind = SLACK_KIND[metric];
  const hook = showroom.settings.slack_webhook_url;
  if (!kind || !hook) return;
  const tz = showroom.timezone;
  await postSlack(hook, bookingSlackMessage({
    kind,
    store: showroom.name,
    type: type.name,
    when: `${formatLongDate(b.startsAt, tz)}, ${formatTime(b.startsAt, tz)}–${formatTime(b.endsAt, tz)}`,
    previous: typeof extra?.previous_display === "string" ? extra.previous_display : undefined,
    customer: b.customerName,
    phone: b.customerPhone,
    email: b.customerEmail,
    answers: readAnswers(b.answers),
    note: b.customerNote,
    url: `${baseUrl()}/app/bookings/${b.id}`,
  }));
}

/** "Question: answer" lines, then the free-text note, for Slack and plain-text templates. */
export function answersText(b: Pick<Booking, "answers" | "customerNote">): string {
  return [...readAnswers(b.answers).map((a) => `${a.question} ${a.answer}`), b.customerNote ? `Note: ${b.customerNote}` : ""].filter(Boolean).join("\n");
}

/** Klaviyo properties for a booking event. Times are in the profile's time zone. */
export function bookingProperties(showroom: ShowroomCtx, type: BookingType, b: Booking): Record<string, unknown> {
  const tz = showroom.timezone;
  return {
    booking_type: type.name,
    booking_type_slug: type.slug,
    location_kind: type.location,
    location_label: LOCATION_LABEL[type.location as BookingLocation],
    showroom: showroom.name,
    showroom_kind: showroom.kind,
    showroom_address: type.location === "in_person" ? showroom.addressLine : "",
    showroom_phone: showroom.phone ?? "",
    customer_name: b.customerName,
    date_display: formatLongDate(b.startsAt, tz),
    time_display: `${formatTime(b.startsAt, tz)} – ${formatTime(b.endsAt, tz)}`,
    starts_at: b.startsAt.toISOString(),
    duration_min: type.durationMin,
    customer_note: b.customerNote,
    // The booking form's answers: a list for flows that loop, and one line per answer for plain templates.
    answers: readAnswers(b.answers),
    answers_text: answersText(b),
    sms_consent: b.smsConsent,
    ...bookingUrls(b),
  };
}

/**
 * Send one booking event and record it on the timeline. Never throws: the booking is already saved, so a
 * Klaviyo outage only marks the event "failed" for staff to see.
 */
async function notifyBooking(
  db: Db,
  args: { showroom: ShowroomCtx; type: BookingType; booking: Booking; metric: string; actor: string; extra?: Record<string, unknown> },
): Promise<"sent" | "failed"> {
  const { showroom, type, booking, metric } = args;
  const properties = { ...bookingProperties(showroom, type, booking), ...args.extra };
  const uniqueId = `${booking.id}:${metric}:${booking.rescheduleCount}`;
  let status: "sent" | "failed" = "sent";
  try {
    await getNotifier().send(metric, { email: booking.customerEmail, phone: booking.customerPhone, name: booking.customerName, smsConsent: booking.smsConsent }, properties, uniqueId);
  } catch (err) {
    status = "failed";
    logger.warn({ err: err instanceof Error ? err.message : String(err), metric, bookingId: booking.id }, "booking event not sent");
  }
  await pingSlack(showroom, type, booking, metric, args.extra);
  await db.insert(events).values({
    showroomId: showroom.id,
    type: `booking_${metric.replace(/^Booking:\s*/, "").toLowerCase().replace(/\s+/g, "_")}`,
    actor: args.actor,
    payload: { booking_id: booking.id, booking_type_id: type.id, booking_type: type.name, starts_at: booking.startsAt.toISOString(), metric },
    klaviyoStatus: status,
  });
  return status;
}

/**
 * Day-before reminders for tomorrow's bookings, run by the clock after the store's reminder hour. One per
 * booking and start time: a booking moved after its reminder gets a fresh one if it lands on a new tomorrow.
 */
export async function sendBookingReminders(db: Db, showroom: ShowroomCtx, tomorrow: string): Promise<{ sent: number; failed: number }> {
  const rows = await db
    .select({ booking: bookings, type: bookingTypes })
    .from(bookings)
    .innerJoin(bookingTypes, eq(bookingTypes.id, bookings.bookingTypeId))
    .where(and(eq(bookings.showroomId, showroom.id), eq(bookings.status, "booked"), eq(bookings.onDate, tomorrow)));
  let sent = 0;
  let failed = 0;
  for (const { booking, type } of rows) {
    const [done] = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.type, "booking_reminder_day_before"), eq(events.klaviyoStatus, "sent"), sql`${events.payload}->>'booking_id' = ${booking.id}`, sql`${events.payload}->>'starts_at' = ${booking.startsAt.toISOString()}`))
      .limit(1);
    if (done) continue;
    const outcome = await notifyBooking(db, { showroom, type, booking, metric: BOOKING_METRIC.reminder, actor: "clock" });
    if (outcome === "sent") sent++;
    else failed++;
  }
  return { sent, failed };
}

// ---- Staff side ---------------------------------------------------------------------------------

export type BookingRow = { booking: Booking; type: BookingType };

/** Bookings for a profile between two local dates (inclusive), cancelled ones left out unless asked. */
export async function listBookings(dbx: DbOrTx, showroomId: string, from: string, to: string, opts: { includeCancelled?: boolean } = {}): Promise<BookingRow[]> {
  return dbx
    .select({ booking: bookings, type: bookingTypes })
    .from(bookings)
    .innerJoin(bookingTypes, eq(bookingTypes.id, bookings.bookingTypeId))
    .where(and(eq(bookings.showroomId, showroomId), between(bookings.onDate, from, to), opts.includeCancelled ? undefined : ne(bookings.status, "cancelled")))
    .orderBy(asc(bookings.startsAt));
}

/** One booking in this profile, with its timeline (newest first). */
export async function getBookingDetail(dbx: DbOrTx, showroomId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await dbx
    .select({ booking: bookings, type: bookingTypes })
    .from(bookings)
    .innerJoin(bookingTypes, eq(bookingTypes.id, bookings.bookingTypeId))
    .where(and(eq(bookings.id, id), eq(bookings.showroomId, showroomId)));
  if (!row) return null;
  const timeline = await dbx
    .select()
    .from(events)
    .where(and(eq(events.showroomId, showroomId), sql`${events.payload}->>'booking_id' = ${id}`))
    .orderBy(desc(events.createdAt));
  return { ...row, timeline };
}

/**
 * Staff mark how it went: checked in (completed) or no-show. Only a booked appointment that has started can
 * be marked; "booked" again undoes either mark. No customer message: Klaviyo hears only confirm/move/cancel.
 */
export async function setBookingOutcome(
  db: Db,
  args: { showroomId: string; bookingId: string; outcome: "completed" | "no_show" | "booked"; actor: string; now?: Date },
): Promise<Booking> {
  const [current] = await db.select().from(bookings).where(and(eq(bookings.id, args.bookingId), eq(bookings.showroomId, args.showroomId)));
  if (!current) throw new TypeBookingError("NOT_ACTIVE");
  const now = args.now ?? new Date();
  if (args.outcome === "booked") {
    if (current.status !== "completed" && current.status !== "no_show") throw new TypeBookingError("NOT_ACTIVE");
  } else {
    if (current.status !== "booked") throw new TypeBookingError("NOT_ACTIVE");
    if (args.outcome === "no_show" && current.startsAt > now) throw new TypeBookingError("TOO_EARLY");
  }
  const [row] = await db.update(bookings).set({ status: args.outcome }).where(eq(bookings.id, current.id)).returning();
  await db.insert(events).values({
    showroomId: current.showroomId,
    type: args.outcome === "completed" ? "booking_checked_in" : args.outcome === "no_show" ? "booking_no_show" : "booking_outcome_undone",
    actor: args.actor,
    payload: { booking_id: current.id, booking_type_id: current.bookingTypeId, previous: current.status },
  });
  return row;
}

// ---- Lightspeed work orders for service bookings ------------------------------------------------

/**
 * The Lightspeed customer for a booking, matched by email or phone against orders Kickstand already mirrors
 * (special orders carry their Lightspeed customerID; phones are stored E.164, like bookings). Null = new customer.
 */
export async function matchLightspeedCustomer(dbx: DbOrTx, b: Pick<Booking, "customerEmail" | "customerPhone">): Promise<string | null> {
  const conds = [
    b.customerEmail ? sql`lower(${orders.customerEmail}) = ${b.customerEmail.toLowerCase()}` : undefined,
    b.customerPhone ? eq(orders.customerPhone, b.customerPhone) : undefined,
  ].filter(Boolean);
  if (!conds.length) return null;
  const [row] = await dbx
    .select({ id: orders.lsCustomerId })
    .from(orders)
    .where(and(isNotNull(orders.lsCustomerId), or(...conds)))
    .orderBy(desc(orders.updatedAt))
    .limit(1);
  return row?.id ?? null;
}

function workorderNote(showroom: ShowroomCtx, type: BookingType, b: Booking): string {
  const tz = showroom.timezone;
  const when = `${formatLongDate(b.startsAt, tz)} ${formatTime(b.startsAt, tz)}–${formatTime(b.endsAt, tz)}`;
  return [
    b.status === "cancelled" ? `CANCELLED (${b.cancelledReason === "customer" ? "by the customer" : "by staff"}) · was booked for ${when}` : "",
    `${type.name.toUpperCase()} · booked in Kickstand`,
    b.status === "cancelled" ? "" : `CUSTOMER BOOKED: ${when}`,
    ...readAnswers(b.answers).map((a) => `${a.question} ${a.answer}`),
    b.customerNote ? `Customer says: ${b.customerNote}` : "",
    [b.customerName, b.customerPhone, b.customerEmail].filter(Boolean).join(" · "),
    `Manage: ${bookingUrls(b).manage_url}`,
  ].filter(Boolean).join("\n");
}

/**
 * Keep a service booking's Lightspeed work order in step (design rule: staff never retype a booking into
 * Lightspeed). First booking: match or create the customer, create the work order in the store's "new work
 * order" status with Due = the appointment. Later changes only move Due, Hook Out and the note — the status is
 * never changed here, so Ikeono's status automations can't fire by surprise. Never throws: a failure is logged
 * on the booking's timeline and staff can retry from the booking page.
 */
export async function syncBookingWorkorder(db: Db, args: { showroom: ShowroomCtx; type: BookingType; booking: Booking; actor: string }): Promise<Booking | null> {
  const { showroom, type } = args;
  if (!type.createsWorkOrder || type.location !== "in_person" || !lightspeedEnabled(showroom)) return null;
  const [b] = await db.select().from(bookings).where(eq(bookings.id, args.booking.id));
  if (!b) return null;
  if (!b.lsWorkorderId && b.status !== "booked") return null;
  const ls = showroom.settings.lightspeed;
  const tz = showroom.timezone;
  const common = {
    note: workorderNote(showroom, type, b),
    internalNote: `Kickstand booking ${baseUrl()}/app/bookings/${b.id}`,
    etaOut: b.startsAt.toISOString(),
    hookIn: type.name.slice(0, 40),
    hookOut: b.status === "cancelled" ? "CANCELLED" : `Booked ${formatInTimeZone(b.startsAt, tz, "EEE d MMM h:mm aaa")}`,
  };
  try {
    const client = new LightspeedClient(db);
    if (b.lsWorkorderId) {
      await client.updateWorkorder(b.lsWorkorderId, common);
      await db.insert(events).values({ showroomId: showroom.id, type: "booking_workorder_updated", actor: args.actor, payload: { booking_id: b.id, workorder_id: b.lsWorkorderId } });
      return b;
    }
    let customerID = await matchLightspeedCustomer(db, b);
    const matched = !!customerID;
    if (!customerID) customerID = await client.createCustomer({ customerName: b.customerName, customerEmail: b.customerEmail, customerPhone: b.customerPhone });
    const workorderID = await client.createWorkorder({
      shopID: ls.shop_id,
      customerID: Number(customerID),
      ...(ls.employee_id ? { employeeID: ls.employee_id } : {}),
      timeIn: new Date().toISOString(),
      warranty: false,
      workorderStatusID: ls.open_status_id,
      ...common,
    });
    const [row] = await db.update(bookings).set({ lsWorkorderId: workorderID }).where(eq(bookings.id, b.id)).returning();
    await db.insert(events).values({ showroomId: showroom.id, type: "booking_workorder_created", actor: args.actor, payload: { booking_id: b.id, workorder_id: workorderID, customer_id: customerID, customer_matched: matched } });
    return row;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message, bookingId: b.id }, "booking work order not synced");
    await db.insert(events).values({ showroomId: showroom.id, type: "booking_workorder_failed", actor: args.actor, payload: { booking_id: b.id, error: message.slice(0, 300) } });
    return null;
  }
}

// ---- Google Calendar copy -------------------------------------------------------------------------

/**
 * Keep the booking's copy on its profile's Google Calendar in step: created when booked, moved when
 * rescheduled, deleted when cancelled. Off when no Google account is connected (or service account set) or the
 * store has no calendar picked. Never throws.
 */
export async function syncBookingCalendar(db: Db, args: { showroom: ShowroomCtx; type: BookingType; bookingId: string; actor: string }): Promise<void> {
  const writer = await getCalendarWriter(db);
  const { showroom, type } = args;
  const [b] = await db.select().from(bookings).where(eq(bookings.id, args.bookingId));
  if (!writer || !b) return;
  const target = showroom.googleCalendarId;
  try {
    // Gone, or the store switched calendars: take it off the old one first.
    if (b.googleEventId && b.googleCalendarId && (b.status === "cancelled" || b.googleCalendarId !== target)) {
      await writer.remove(b.googleCalendarId, b.googleEventId);
      await db.update(bookings).set({ googleEventId: null, googleCalendarId: null }).where(eq(bookings.id, b.id));
      b.googleEventId = null;
    }
    if (b.status === "cancelled" || !target) return;
    const tz = showroom.timezone;
    const eventId = await writer.upsert(target, b.googleEventId, {
      summary: `${type.name} · ${b.customerName}`,
      description: [
        `${LOCATION_LABEL[type.location as BookingLocation]} · booked in Kickstand`,
        [b.customerPhone, b.customerEmail].filter(Boolean).join(" · "),
        answersText(b),
        `Open in Kickstand: ${baseUrl()}/app/bookings/${b.id}`,
      ].filter(Boolean).join("\n"),
      location: type.location === "in_person" ? showroom.addressLine : LOCATION_LABEL[type.location as BookingLocation],
      start: b.startsAt,
      end: b.endsAt,
      timeZone: tz,
    });
    if (eventId !== b.googleEventId || b.googleCalendarId !== target) await db.update(bookings).set({ googleEventId: eventId, googleCalendarId: target }).where(eq(bookings.id, b.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message, bookingId: b.id }, "booking calendar copy failed");
    await db.insert(events).values({ showroomId: showroom.id, type: "booking_calendar_failed", actor: args.actor, payload: { booking_id: b.id, error: message.slice(0, 300) } });
  }
}
