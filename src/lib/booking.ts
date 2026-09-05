import { and, count, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { appointments, dayCounters, orders, units, type Appointment, type Order, type Unit } from "@/db/schema";
import { effectiveCapacity, slotStarts } from "./capacity";
import { logEvent } from "./events";
import { flushOutbox, METRIC, type Outbox } from "./messages";
import { getCapacityConfig, type ShowroomCtx } from "./showroom";
import { storageEstimateCents } from "./storage";
import {
  addHours,
  addLocalDays,
  formatDateTime,
  hoursBetween,
  localToUtc,
  startOfLocalDay,
  toLocalDate,
} from "./time";
import { formatMoneyOrEmpty } from "./format";

export type BookingErrorCode =
  | "DAY_FULL"
  | "TIME_FULL"
  | "TOO_EARLY"
  | "CLOSED"
  | "HORIZON"
  | "INVALID_SLOT"
  | "ALREADY_BOOKED"
  | "NOT_BOOKABLE"
  | "NO_APPOINTMENT"
  | "SLOT_NOT_PASSED";

export class BookingError extends Error {
  constructor(
    public code: BookingErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "BookingError";
  }
}

export const BOOKING_ERROR_TEXT: Record<BookingErrorCode, string> = {
  DAY_FULL: "That day just filled up. Please pick another day.",
  TIME_FULL: "That time was just taken. Please pick another time.",
  TOO_EARLY: "That time is too soon — we need a little notice to build your bike.",
  CLOSED: "The showroom is closed that day.",
  HORIZON: "That date is beyond the booking window.",
  INVALID_SLOT: "That time isn't a valid pickup slot.",
  ALREADY_BOOKED: "You already have a pickup booked. Use Reschedule to change it.",
  NOT_BOOKABLE: "This bike can't be booked right now. Please call the showroom.",
  NO_APPOINTMENT: "There is no booked pickup to change.",
  SLOT_NOT_PASSED: "You can only record a no-show after the slot start time.",
};

async function loadUnitForUpdate(tx: Tx, unitId: string): Promise<{ unit: Unit; order: Order | null }> {
  const [unit] = await tx.select().from(units).where(eq(units.id, unitId)).for("update");
  if (!unit) throw new BookingError("NOT_BOOKABLE", "Unit not found");
  const order = unit.orderId
    ? (await tx.select().from(orders).where(eq(orders.id, unit.orderId)).limit(1))[0] ?? null
    : null;
  return { unit, order };
}

async function activeAppointment(tx: Tx, unitId: string): Promise<Appointment | null> {
  const [a] = await tx
    .select()
    .from(appointments)
    .where(and(eq(appointments.unitId, unitId), eq(appointments.status, "booked")))
    .limit(1);
  return a ?? null;
}

export async function decrementCounter(tx: Tx, showroomId: string, onDate: string) {
  await tx
    .update(dayCounters)
    .set({ bookedCount: sql`greatest(${dayCounters.bookedCount} - 1, 0)` })
    .where(and(eq(dayCounters.showroomId, showroomId), eq(dayCounters.onDate, onDate)));
}

/** R9: second no-show on the same unit starts storage immediately (harmless for terms v1). */
async function bumpNoShow(tx: Tx, unit: Unit, tz: string, now: Date): Promise<number> {
  const next = unit.noShowCount + 1;
  await tx
    .update(units)
    .set({
      noShowCount: next,
      ...(next >= 2 && !unit.storageFrom ? { storageFrom: startOfLocalDay(toLocalDate(now, tz), tz) } : {}),
    })
    .where(eq(units.id, unit.id));
  return next;
}

export type BookArgs = {
  showroom: ShowroomCtx;
  unitId: string;
  startsAt: Date;
  createdBy: string;
  smsConsent?: boolean;
  now?: Date;
  /** Set by reschedule: the appointment being replaced (already cancelled in this tx). */
  replacingAppointmentId?: string;
  /** Staff booking on the customer's behalf may skip min_lead_hours (bike already built, customer waiting). */
  allowShortNotice?: boolean;
};

/** §6.3 booking transaction body. Throws BookingError; the caller's transaction rolls back. */
export async function bookSlotTx(
  tx: Tx,
  outbox: Outbox,
  args: BookArgs,
): Promise<{ appointment: Appointment; unit: Unit; order: Order | null }> {
  const { showroom, startsAt, createdBy } = args;
  const now = args.now ?? new Date();
  const tz = showroom.timezone;
  const settings = showroom.settings;

  const { unit, order } = await loadUnitForUpdate(tx, args.unitId);
  if (!["invited", "booked", "building", "ready"].includes(unit.status) || !unit.invitedAt || !unit.pickupBy) {
    throw new BookingError("NOT_BOOKABLE");
  }
  const active = await activeAppointment(tx, unit.id);
  if (active && active.id !== args.replacingAppointmentId) throw new BookingError("ALREADY_BOOKED");

  const date = toLocalDate(startsAt, tz);
  const { rules, overrides } = await getCapacityConfig(tx, showroom.id, date);
  const day = effectiveCapacity(date, rules, overrides);
  if (day.closed) throw new BookingError("CLOSED");
  const validStart = slotStarts(day, settings.slot_minutes).some(
    (s) => localToUtc(date, s, tz).getTime() === startsAt.getTime(),
  );
  if (!validStart) throw new BookingError("INVALID_SLOT");
  if (!args.allowShortNotice && startsAt < addHours(now, settings.min_lead_hours)) throw new BookingError("TOO_EARLY");
  if (startsAt < now) throw new BookingError("TOO_EARLY");
  const latestDate = addLocalDays(toLocalDate(unit.invitedAt, tz), settings.booking_horizon_days);
  if (date > latestDate) throw new BookingError("HORIZON");

  // 1–2: the counter row lock serialises every booking for this day.
  await tx
    .insert(dayCounters)
    .values({ showroomId: showroom.id, onDate: date, bookedCount: 0 })
    .onConflictDoNothing();
  const bumped = await tx
    .update(dayCounters)
    .set({ bookedCount: sql`${dayCounters.bookedCount} + 1` })
    .where(
      and(
        eq(dayCounters.showroomId, showroom.id),
        eq(dayCounters.onDate, date),
        sql`${dayCounters.bookedCount} < ${day.capacity}`,
      ),
    )
    .returning({ bookedCount: dayCounters.bookedCount });
  if (bumped.length === 0) throw new BookingError("DAY_FULL");

  // 3: same-time concurrency (safe without a lock — step 2 serialised this day).
  const [{ atTime }] = await tx
    .select({ atTime: count() })
    .from(appointments)
    .where(
      and(
        eq(appointments.showroomId, showroom.id),
        eq(appointments.startsAt, startsAt),
        eq(appointments.status, "booked"),
      ),
    );
  if (atTime >= day.maxConcurrent) throw new BookingError("TIME_FULL");

  // 4
  const endsAt = new Date(startsAt.getTime() + settings.slot_minutes * 60_000);
  const [appointment] = await tx
    .insert(appointments)
    .values({
      showroomId: showroom.id,
      unitId: unit.id,
      onDate: date,
      startsAt,
      endsAt,
      status: "booked",
      createdBy,
    })
    .returning();

  // 5 (+ R15 early bird on the first ever booking)
  const [{ previous }] = await tx
    .select({ previous: count() })
    .from(appointments)
    .where(and(eq(appointments.unitId, unit.id), sql`${appointments.id} <> ${appointment.id}`));
  const earlyBird =
    settings.early_bird_enabled &&
    previous === 0 &&
    hoursBetween(unit.invitedAt, now) <= settings.early_bird_hours;
  const unitPatch: Partial<Unit> = {};
  if (unit.status === "invited") unitPatch.status = "booked";
  if (earlyBird) unitPatch.earlyBird = true;
  if (Object.keys(unitPatch).length) await tx.update(units).set(unitPatch).where(eq(units.id, unit.id));
  if (order && args.smsConsent !== undefined && args.smsConsent !== order.smsConsent) {
    await tx.update(orders).set({ smsConsent: args.smsConsent }).where(eq(orders.id, order.id));
    order.smsConsent = args.smsConsent;
  }

  // 6
  await logEvent(tx, {
    showroomId: showroom.id,
    unitId: unit.id,
    orderId: order?.id,
    appointmentId: appointment.id,
    type: args.replacingAppointmentId ? "booking_rescheduled" : "booking_confirmed",
    actor: createdBy,
    payload: { starts_at: startsAt.toISOString(), on_date: date, early_bird: earlyBird },
  });

  const updatedUnit: Unit = { ...unit, ...unitPatch };
  const storageEstimate = storageEstimateCents(unit, order?.termsVersion ?? 1, settings, date, tz);
  if (!args.replacingAppointmentId) {
    outbox.push({
      showroom,
      unit: updatedUnit,
      order,
      metric: METRIC.booked,
      dedupeKey: appointment.id,
      actor: createdBy,
      extra: {
        slot_start_local: formatDateTime(startsAt, tz),
        slot_end_local: formatDateTime(endsAt, tz),
        calendar_ics_url: `${(process.env.APP_BASE_URL ?? "").replace(/\/$/, "")}/api/ics/${appointment.id}`,
        storage_estimate_display: formatMoneyOrEmpty(storageEstimate),
      },
    });
  }
  return { appointment, unit: updatedUnit, order };
}

export async function bookSlot(dbx: Db, args: BookArgs) {
  const outbox: Outbox = [];
  const result = await dbx.transaction((tx) => bookSlotTx(tx, outbox, args));
  await flushOutbox(dbx, outbox);
  return result;
}

export type CancelArgs = {
  showroom: ShowroomCtx;
  unitId: string;
  /** 'customer' applies the R8 cutoff. 'shop' (we closed / can't make the slot) texts the customer a
   *  rebook link with no penalty. 'deferred' and 'staff' never count as a no-show and send nothing. */
  reason: "customer" | "shop" | "staff" | "deferred";
  actor: string;
  now?: Date;
  /** Reschedule sets this so no "Cancelled" message is queued. */
  silent?: boolean;
};

export async function cancelBookingTx(
  tx: Tx,
  outbox: Outbox,
  args: CancelArgs,
): Promise<{ appointment: Appointment; unit: Unit; order: Order | null; lateChange: boolean }> {
  const { showroom, reason, actor } = args;
  const now = args.now ?? new Date();
  const tz = showroom.timezone;
  const { unit, order } = await loadUnitForUpdate(tx, args.unitId);
  const active = await activeAppointment(tx, unit.id);
  if (!active) throw new BookingError("NO_APPOINTMENT");

  const cutoff = addHours(active.startsAt, -showroom.settings.reschedule_cutoff_hours);
  const lateChange = reason === "customer" && now > cutoff;

  const [appointment] = await tx
    .update(appointments)
    .set(
      lateChange
        ? { status: "no_show", cancelledReason: "late_change" }
        : { status: "cancelled", cancelledReason: reason },
    )
    .where(eq(appointments.id, active.id))
    .returning();
  await decrementCounter(tx, showroom.id, active.onDate);

  let noShowCount = unit.noShowCount;
  if (lateChange) {
    noShowCount = await bumpNoShow(tx, unit, tz, now);
    await logEvent(tx, {
      showroomId: showroom.id,
      unitId: unit.id,
      orderId: order?.id,
      appointmentId: active.id,
      type: "no_show",
      actor,
      payload: { reason: "late_change", no_show_count: noShowCount },
    });
  }

  // Unit keeps its build state; an unbuilt booked unit returns to invited.
  const unitPatch: Partial<Unit> = {};
  if (unit.status === "booked") unitPatch.status = "invited";
  if (Object.keys(unitPatch).length) await tx.update(units).set(unitPatch).where(eq(units.id, unit.id));

  await logEvent(tx, {
    showroomId: showroom.id,
    unitId: unit.id,
    orderId: order?.id,
    appointmentId: active.id,
    type: "booking_cancelled",
    actor,
    payload: { reason, late_change: lateChange, starts_at: active.startsAt.toISOString() },
  });

  const updatedUnit: Unit = { ...unit, ...unitPatch, noShowCount };
  if (!args.silent && (reason === "customer" || reason === "shop")) {
    outbox.push({
      showroom,
      unit: updatedUnit,
      order,
      metric: METRIC.cancelled,
      dedupeKey: active.id,
      actor,
      extra: {
        // Klaviyo branches on this: "you cancelled" vs "sorry, we had to cancel — please pick a new time".
        cancelled_by: reason,
        slot_start_local: formatDateTime(active.startsAt, tz),
        days_left_display: unit.pickupBy
          ? `${Math.max(0, Math.ceil(hoursBetween(now, unit.pickupBy) / 24))} days`
          : "",
        late_change: lateChange,
      },
    });
  }
  return { appointment, unit: updatedUnit, order, lateChange };
}

export async function cancelBooking(dbx: Db, args: CancelArgs) {
  const outbox: Outbox = [];
  const result = await dbx.transaction((tx) => cancelBookingTx(tx, outbox, args));
  await flushOutbox(dbx, outbox);
  return result;
}

export type RescheduleArgs = {
  showroom: ShowroomCtx;
  unitId: string;
  startsAt: Date;
  actor: string;
  smsConsent?: boolean;
  now?: Date;
};

/** Reschedule = cancel + book in one transaction; old.replaced_by = new.id. */
export async function rescheduleBooking(dbx: Db, args: RescheduleArgs) {
  const outbox: Outbox = [];
  const result = await dbx.transaction(async (tx) => {
    const cancelled = await cancelBookingTx(tx, outbox, {
      showroom: args.showroom,
      unitId: args.unitId,
      reason: "customer",
      actor: args.actor,
      now: args.now,
      silent: true,
    });
    const booked = await bookSlotTx(tx, outbox, {
      showroom: args.showroom,
      unitId: args.unitId,
      startsAt: args.startsAt,
      createdBy: args.actor,
      smsConsent: args.smsConsent,
      now: args.now,
      replacingAppointmentId: cancelled.appointment.id,
    });
    await tx
      .update(appointments)
      .set({ replacedBy: booked.appointment.id })
      .where(eq(appointments.id, cancelled.appointment.id));
    const tz = args.showroom.timezone;
    outbox.push({
      showroom: args.showroom,
      unit: booked.unit,
      order: booked.order,
      metric: METRIC.rescheduled,
      dedupeKey: booked.appointment.id,
      actor: args.actor,
      extra: {
        old_slot_start_local: formatDateTime(cancelled.appointment.startsAt, tz),
        slot_start_local: formatDateTime(booked.appointment.startsAt, tz),
        slot_end_local: formatDateTime(booked.appointment.endsAt, tz),
        late_change: cancelled.lateChange,
        calendar_ics_url: `${(process.env.APP_BASE_URL ?? "").replace(/\/$/, "")}/api/ics/${booked.appointment.id}`,
      },
    });
    return { ...booked, previous: cancelled.appointment, lateChange: cancelled.lateChange };
  });
  await flushOutbox(dbx, outbox);
  return result;
}

/** Staff records a no-show after the slot start has passed (§7.2 ready → ready). */
export async function recordNoShow(
  dbx: Db,
  args: { showroom: ShowroomCtx; unitId: string; actor: string; now?: Date },
) {
  const outbox: Outbox = [];
  const result = await dbx.transaction(async (tx) => {
    const { showroom, actor } = args;
    const now = args.now ?? new Date();
    const { unit, order } = await loadUnitForUpdate(tx, args.unitId);
    const active = await activeAppointment(tx, unit.id);
    if (!active) throw new BookingError("NO_APPOINTMENT");
    if (active.startsAt > now) throw new BookingError("SLOT_NOT_PASSED");

    const [appointment] = await tx
      .update(appointments)
      .set({ status: "no_show" })
      .where(eq(appointments.id, active.id))
      .returning();
    await decrementCounter(tx, showroom.id, active.onDate);
    const noShowCount = await bumpNoShow(tx, unit, showroom.timezone, now);
    const unitPatch: Partial<Unit> = {};
    if (unit.status === "booked") unitPatch.status = "invited";
    if (Object.keys(unitPatch).length) await tx.update(units).set(unitPatch).where(eq(units.id, unit.id));
    await logEvent(tx, {
      showroomId: showroom.id,
      unitId: unit.id,
      orderId: order?.id,
      appointmentId: active.id,
      type: "no_show",
      actor,
      payload: { no_show_count: noShowCount, starts_at: active.startsAt.toISOString() },
    });
    const [fresh] = await tx.select().from(units).where(eq(units.id, unit.id));
    outbox.push({
      showroom,
      unit: fresh,
      order,
      metric: METRIC.missed,
      dedupeKey: active.id,
      actor,
      extra: { second_missed: noShowCount >= 2 },
    });
    return { appointment, unit: fresh, order, noShowCount };
  });
  await flushOutbox(dbx, outbox);
  return result;
}
