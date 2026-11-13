/**
 * Customers booking a standard booking type (test ride, service, video call…) from a profile's public
 * booking page, plus reschedule and cancel from the manage link. Bike pickups keep their own flow
 * (booking.ts). Each confirmed change fires one Klaviyo event ("Booking: Confirmed" / "Rescheduled" /
 * "Cancelled"); the flow in Klaviyo owns the wording and channel, as for pickups.
 */
import { and, asc, between, desc, eq, ne, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@/db/client";
import { bookings, bookingTypes, events, type Booking, type BookingType } from "@/db/schema";
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
  args: { showroom: ShowroomCtx; type: BookingType; startsAt: Date; details: CustomerDetails; createdBy: string; now?: Date },
): Promise<{ booking: Booking; token: string }> {
  const { showroom, type } = args;
  if (type.kind !== "standard" || type.showroomId !== showroom.id) throw new TypeBookingError("NOT_BOOKABLE");
  if (!type.active || (type.access !== "public" && args.createdBy === "customer")) throw new TypeBookingError("NOT_BOOKABLE");
  const details = cleanDetails(args.details);
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
        tokenHash: hashToken(token),
        tokenEnc: encryptToken(token),
        createdBy: args.createdBy,
      })
      .returning();
    return row;
  });
  await notifyBooking(db, { showroom, type, booking, metric: BOOKING_METRIC.confirmed, actor: args.createdBy });
  return { booking, token };
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
  return result.booking;
}

export async function cancelTypeBooking(db: Db, args: { bookingId: string; actor: string; reason: string; now?: Date }): Promise<Booking> {
  const [current] = await db.select().from(bookings).where(eq(bookings.id, args.bookingId));
  if (!current || current.status !== "booked") throw new TypeBookingError("NOT_ACTIVE");
  const [row] = await db.update(bookings).set({ status: "cancelled", cancelledReason: args.reason }).where(eq(bookings.id, current.id)).returning();
  const [type] = await db.select().from(bookingTypes).where(eq(bookingTypes.id, current.bookingTypeId));
  const showroom = await getShowroomById(db, current.showroomId);
  await notifyBooking(db, { showroom, type, booking: row, metric: BOOKING_METRIC.cancelled, actor: args.actor });
  return row;
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
): Promise<void> {
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
  await db.insert(events).values({
    showroomId: showroom.id,
    type: `booking_${metric.replace(/^Booking:\s*/, "").toLowerCase()}`,
    actor: args.actor,
    payload: { booking_id: booking.id, booking_type_id: type.id, booking_type: type.name, starts_at: booking.startsAt.toISOString(), metric },
    klaviyoStatus: status,
  });
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
