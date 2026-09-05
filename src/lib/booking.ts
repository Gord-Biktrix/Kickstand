import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { appointments, dayCounters, orders, units, type Appointment, type Order, type Unit } from "@/db/schema";
import { effectiveCapacity, slotStarts } from "./capacity";
import { logEvent } from "./events";
import { baseUrl, flushOutbox, METRIC, type Outbox } from "./messages";
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
  /** Multi-bike visit: shared group id (see bookGroup). */
  groupId?: string;
  /** Group siblings: book without a message — the primary bike's message covers the visit. */
  silent?: boolean;
  /** Extra Klaviyo properties (bike_count, bikes) merged into the Booked message. */
  extra?: Record<string, unknown>;
};

/** Units that share a visit with this appointment (the appointment's own unit first). */
export async function groupUnitIds(tx: Tx | Db, appointment: Pick<Appointment, "id" | "unitId" | "groupId">): Promise<string[]> {
  if (!appointment.groupId) return [appointment.unitId];
  const rows = await tx
    .select({ unitId: appointments.unitId })
    .from(appointments)
    .where(and(eq(appointments.groupId, appointment.groupId), eq(appointments.status, "booked")));
  const ids = rows.map((r) => r.unitId);
  return [appointment.unitId, ...ids.filter((id) => id !== appointment.unitId)];
}

/** "Model · colour" per bike, for the bikes/bike_count message properties. */
export async function describeUnits(tx: Tx | Db, unitIds: string[]): Promise<{ bike_count: number; bikes: string[] }> {
  if (unitIds.length === 0) return { bike_count: 0, bikes: [] };
  const rows = await tx.select({ id: units.id, model: units.model, colour: units.colour, size: units.size }).from(units).where(inArray(units.id, unitIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const bikes = unitIds.map((id) => byId.get(id)).filter((u): u is NonNullable<typeof u> => !!u).map((u) => [u.model, u.colour, u.size].filter(Boolean).join(" · "));
  return { bike_count: bikes.length, bikes };
}

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
        // Bikes in the same visit share the time on purpose.
        args.groupId ? sql`${appointments.groupId} is distinct from ${args.groupId}` : undefined,
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
      groupId: args.groupId ?? null,
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
  if (!args.replacingAppointmentId && !args.silent) {
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
        calendar_ics_url: `${baseUrl()}/api/ics/${appointment.id}`,
        storage_estimate_display: formatMoneyOrEmpty(storageEstimate),
        bike_count: 1,
        bikes: [[unit.model, unit.colour, unit.size].filter(Boolean).join(" · ")],
        ...(args.extra ?? {}),
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

export type GroupBookArgs = Omit<BookArgs, "unitId" | "groupId" | "silent" | "extra" | "replacingAppointmentId"> & {
  /** Primary bike first — its customer gets the one message. All must belong to the same customer (caller checks). */
  unitIds: string[];
};

/**
 * One visit, several bikes: every bike gets its own appointment row at the same time, sharing a
 * group id; capacity counts each bike (build time is per bike); the customer gets one Booked message
 * listing them all. One bike → identical to bookSlot.
 */
export async function bookGroup(dbx: Db, args: GroupBookArgs) {
  const ids = [...new Set(args.unitIds)];
  if (ids.length === 0) throw new BookingError("NOT_BOOKABLE", "No bikes selected");
  const outbox: Outbox = [];
  const result = await dbx.transaction(async (tx) => {
    const groupId = ids.length > 1 ? randomUUID() : undefined;
    const summary = await describeUnits(tx, ids);
    const booked = [];
    for (const [i, unitId] of ids.entries()) {
      booked.push(await bookSlotTx(tx, outbox, { ...args, unitId, groupId, silent: i > 0, extra: i === 0 ? summary : undefined }));
    }
    return { groupId: groupId ?? null, primary: booked[0], all: booked };
  });
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
  /** Internal: set while cancelling the other bikes of a visit, so they don't cascade again. */
  _inGroup?: boolean;
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

  // A visit is cancelled as a whole: the other bikes in the group go too, silently (one message covers it).
  const visit = await groupUnitIds(tx, active);
  if (!args._inGroup) {
    for (const sibling of visit.slice(1)) await cancelBookingTx(tx, outbox, { ...args, unitId: sibling, silent: true, _inGroup: true });
  }
  const groupSummary = await describeUnits(tx, visit);

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
        ...groupSummary,
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
    // The whole visit moves: cancel every bike's appointment (silently), rebook them together at the new time.
    const current = await activeAppointment(tx, args.unitId);
    if (!current) throw new BookingError("NO_APPOINTMENT");
    const visit = await groupUnitIds(tx, current);
    const newGroupId = visit.length > 1 ? randomUUID() : undefined;
    const summary = await describeUnits(tx, visit);
    const cancelled = await cancelBookingTx(tx, outbox, {
      showroom: args.showroom,
      unitId: args.unitId,
      reason: "customer",
      actor: args.actor,
      now: args.now,
      silent: true,
    });
    let booked!: Awaited<ReturnType<typeof bookSlotTx>>;
    for (const [i, unitId] of visit.entries()) {
      const [old] = await tx
        .select()
        .from(appointments)
        .where(and(eq(appointments.unitId, unitId), eq(appointments.status, "cancelled"), current.groupId ? eq(appointments.groupId, current.groupId) : eq(appointments.id, cancelled.appointment.id)))
        .orderBy(sql`${appointments.updatedAt} desc`)
        .limit(1);
      const b = await bookSlotTx(tx, outbox, {
        showroom: args.showroom,
        unitId,
        startsAt: args.startsAt,
        createdBy: args.actor,
        smsConsent: args.smsConsent,
        now: args.now,
        replacingAppointmentId: old?.id ?? cancelled.appointment.id,
        groupId: newGroupId,
        silent: true,
      });
      if (old) await tx.update(appointments).set({ replacedBy: b.appointment.id }).where(eq(appointments.id, old.id));
      if (i === 0) booked = b;
    }
    const tz = args.showroom.timezone;
    outbox.push({
      showroom: args.showroom,
      unit: booked.unit,
      order: booked.order,
      metric: METRIC.rescheduled,
      dedupeKey: booked.appointment.id,
      actor: args.actor,
      extra: {
        ...summary,
        old_slot_start_local: formatDateTime(cancelled.appointment.startsAt, tz),
        slot_start_local: formatDateTime(booked.appointment.startsAt, tz),
        slot_end_local: formatDateTime(booked.appointment.endsAt, tz),
        late_change: cancelled.lateChange,
        calendar_ics_url: `${baseUrl()}/api/ics/${booked.appointment.id}`,
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

    // The customer missed the visit, so every bike in it is a no-show; one message.
    const visit = await groupUnitIds(tx, active);
    const summary = await describeUnits(tx, visit);
    let appointment!: Appointment;
    let noShowCount = 0;
    for (const unitId of visit) {
      const { unit: u, order: o } = unitId === unit.id ? { unit, order } : await loadUnitForUpdate(tx, unitId);
      const a = unitId === unit.id ? active : await activeAppointment(tx, unitId);
      if (!a) continue;
      const [updated] = await tx.update(appointments).set({ status: "no_show" }).where(eq(appointments.id, a.id)).returning();
      await decrementCounter(tx, showroom.id, a.onDate);
      const n = await bumpNoShow(tx, u, showroom.timezone, now);
      const unitPatch: Partial<Unit> = {};
      if (u.status === "booked") unitPatch.status = "invited";
      if (Object.keys(unitPatch).length) await tx.update(units).set(unitPatch).where(eq(units.id, u.id));
      await logEvent(tx, {
        showroomId: showroom.id,
        unitId: u.id,
        orderId: o?.id,
        appointmentId: a.id,
        type: "no_show",
        actor,
        payload: { no_show_count: n, starts_at: a.startsAt.toISOString(), group_id: a.groupId },
      });
      if (unitId === unit.id) { appointment = updated; noShowCount = n; }
    }
    const [fresh] = await tx.select().from(units).where(eq(units.id, unit.id));
    outbox.push({
      showroom,
      unit: fresh,
      order,
      metric: METRIC.missed,
      dedupeKey: active.id,
      actor,
      extra: { second_missed: noShowCount >= 2, ...summary },
    });
    return { appointment, unit: fresh, order, noShowCount };
  });
  await flushOutbox(dbx, outbox);
  return result;
}
