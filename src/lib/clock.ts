import { and, eq, isNotNull, notInArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { appointments, dayCounters, events, orders, units, type Unit } from "@/db/schema";
import { effectiveCapacity } from "./capacity";
import { formatMoney } from "./format";
import { logger } from "./logger";
import { METRIC, sendUnitMessage, type MessageOutcome } from "./messages";
import { getCapacityConfig, listShowrooms, patchShowroomSettings, type ShowroomCtx } from "./showroom";
import { syncSpecialOrders } from "./special-orders";
import { syncWorkorders } from "./workorders";
import { storageDueCents, storageEnabledFor } from "./storage";
import { addLocalDays, daysBetween, formatDateTime, localHour, startOfLocalDay, toLocalDate, weekdayOf } from "./time";

export type ClockSummary = {
  showroom: string;
  date: string;
  ranDaily: boolean;
  ranReminders: boolean;
  counts: {
    invited: number;
    booked: number;
    overdue: number;
    releasable: number;
    storageStarted: number;
    messagesSent: number;
    messagesFailed: number;
    messagesSkipped: number;
  };
};

export type ClockOptions = {
  /** Tests: skip the Lightspeed special-order pull. */
  skipSpecialOrders?: boolean;
  now?: Date;
  /** Run the daily actions regardless of local hour (tests, manual replay). Dedupe still applies. */
  forceDaily?: boolean;
  /** Run the day-before reminders regardless of local hour. */
  forceReminders?: boolean;
};

async function nextSaturdayRemaining(dbx: Db, showroom: ShowroomCtx, today: string): Promise<string> {
  let d = today;
  for (let i = 0; i < 7 && weekdayOf(d) !== 6; i++) d = addLocalDays(d, 1);
  const { rules, overrides } = await getCapacityConfig(dbx, showroom.id, d);
  const day = effectiveCapacity(d, rules, overrides);
  const [row] = await dbx
    .select({ booked: dayCounters.bookedCount })
    .from(dayCounters)
    .where(and(eq(dayCounters.showroomId, showroom.id), eq(dayCounters.onDate, d)));
  const remaining = Math.max(0, day.capacity - (row?.booked ?? 0));
  return `${remaining} of ${day.capacity}`;
}

/** §8 — hourly entry point. Safe to replay: every message is deduped on (unit, type, key). */
export async function runClock(dbx: Db, opts: ClockOptions = {}): Promise<ClockSummary[]> {
  const now = opts.now ?? new Date();
  const summaries: ClockSummary[] = [];
  for (const showroom of await listShowrooms(dbx)) {
    summaries.push(await runClockForShowroom(dbx, showroom, now, opts));
    // Pull new bike special orders from Lightspeed every tick (best-effort; the tick must not fail on it).
    if (showroom.settings.lightspeed.shop_id && !opts.skipSpecialOrders) {
      try {
        await syncSpecialOrders(dbx, { showroom, actor: "clock", now });
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err), showroom: showroom.slug }, "clock: special-order sync skipped");
      }
      try {
        await syncWorkorders(dbx, { showroom, actor: "clock", now });
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err), showroom: showroom.slug }, "clock: work-order sync skipped");
      }
    }
  }
  return summaries;
}

export async function runClockForShowroom(
  dbx: Db,
  showroom: ShowroomCtx,
  now: Date,
  opts: ClockOptions,
): Promise<ClockSummary> {
  const tz = showroom.timezone;
  const s = showroom.settings;
  const today = toLocalDate(now, tz);
  const hour = localHour(now, tz);
  const counts: ClockSummary["counts"] = {
    invited: 0,
    booked: 0,
    overdue: 0,
    releasable: 0,
    storageStarted: 0,
    messagesSent: 0,
    messagesFailed: 0,
    messagesSkipped: 0,
  };
  const tally = (o: MessageOutcome) => {
    if (o === "sent") counts.messagesSent++;
    else if (o === "failed") counts.messagesFailed++;
    else counts.messagesSkipped++;
  };

  // Tolerate a late tick (external schedulers can start minutes late): daily actions run at or after
  // the run hour, once per local date; reminders run at or after the send hour and are deduped per
  // appointment, so a second tick the same evening sends nothing.
  const runDaily = opts.forceDaily || (hour >= s.clock_run_hour_local && s.clock_last_run_date !== today);
  const runReminders = opts.forceReminders || hour >= s.reminder_send_hour_local;

  if (runDaily) {
    const rows = await dbx
      .select({ unit: units, order: orders })
      .from(units)
      .leftJoin(orders, eq(orders.id, units.orderId))
      .where(
        and(
          eq(units.showroomId, showroom.id),
          notInArray(units.status, ["picked_up", "unassigned", "received"]),
          eq(units.kind, "bike"),
          isNotNull(units.invitedAt),
        ),
      );

    let saturdayDisplay: string | null = null;
    for (const { unit, order } of rows) {
      const age = daysBetween(toLocalDate(unit.invitedAt!, tz), today);
      if (unit.status === "invited") counts.invited++;
      else counts.booked++;
      if (unit.pickupBy && now > unit.pickupBy) counts.overdue++;
      if (s.release_rule_enabled && unit.status === "invited" && unit.bookBy && now > unit.bookBy) counts.releasable++;

      const base = { showroom, unit, order, dedupeKey: today, actor: "system" as const };
      if (unit.status === "invited") {
        if (age === 3) {
          saturdayDisplay ??= await nextSaturdayRemaining(dbx, showroom, today);
          tally(await sendUnitMessage(dbx, { ...base, metric: METRIC.nudge3, extra: { remaining_saturday_display: saturdayDisplay } }));
        } else if (age === 7) {
          tally(await sendUnitMessage(dbx, { ...base, metric: METRIC.nudge7 }));
        } else if (age === 14) {
          tally(await sendUnitMessage(dbx, { ...base, metric: METRIC.holdEnding }));
        }
      }

      // Storage starts the day after pick-up-by (catches up if a run was missed).
      const termsVersion = order?.termsVersion ?? 1;
      if (unit.pickupBy && !unit.storageFrom && storageEnabledFor(s, termsVersion)) {
        const firstDay = addLocalDays(toLocalDate(unit.pickupBy, tz), 1);
        if (today >= firstDay) {
          const storageFrom = startOfLocalDay(firstDay, tz);
          const [updated] = await dbx.update(units).set({ storageFrom }).where(eq(units.id, unit.id)).returning();
          counts.storageStarted++;
          tally(
            await sendUnitMessage(dbx, {
              ...base,
              unit: updated,
              metric: METRIC.storageStarted,
              extra: { storage_due_display: formatMoney(storageDueCents(updated, termsVersion, s, now, tz)) },
            }),
          );
        }
      }
    }

    await patchShowroomSettings(dbx, showroom.id, { clock_last_run_date: today });
    await dbx.insert(events).values({
      showroomId: showroom.id,
      type: "clock_run",
      actor: "system",
      payload: { dedupe_key: today, date: today, ...counts },
    });
    logger.info({ showroom: showroom.slug, date: today, ...counts }, "clock daily run");
  }

  if (runReminders) {
    const tomorrow = addLocalDays(today, 1);
    const rows = await dbx
      .select({ appointment: appointments, unit: units, order: orders })
      .from(appointments)
      .innerJoin(units, eq(units.id, appointments.unitId))
      .leftJoin(orders, eq(orders.id, units.orderId))
      .where(
        and(
          eq(appointments.showroomId, showroom.id),
          eq(appointments.status, "booked"),
          eq(appointments.onDate, tomorrow),
          eq(units.kind, "bike"),
        ),
      );
    const remindedGroups = new Set<string>();
    for (const { appointment, unit, order } of rows) {
      // One reminder per visit, not per bike.
      if (appointment.groupId) {
        if (remindedGroups.has(appointment.groupId)) continue;
        remindedGroups.add(appointment.groupId);
      }
      const visit = rows.filter((r) => (appointment.groupId ? r.appointment.groupId === appointment.groupId : r.appointment.id === appointment.id));
      tally(
        await sendUnitMessage(dbx, {
          showroom,
          unit,
          order,
          metric: METRIC.reminder,
          dedupeKey: appointment.groupId ?? appointment.id,
          extra: {
            slot_start_local: formatDateTime(appointment.startsAt, tz),
            bring_list: "A copy of your order confirmation, photo ID, and the card used for any balance due",
            built: visit.every((r) => ["building", "ready"].includes(r.unit.status)),
            bike_count: visit.length,
            bikes: visit.map((r) => [r.unit.model, r.unit.colour, r.unit.size].filter(Boolean).join(" · ")),
          },
        }),
      );
    }
  }

  return { showroom: showroom.slug, date: today, ranDaily: runDaily, ranReminders: runReminders, counts };
}

/** Units flagged for the day-10 phone call: invited, age ≥ 10, not yet booked. */
export function callDue(unit: Pick<Unit, "status" | "invitedAt">, now: Date, tz: string): boolean {
  if (unit.status !== "invited" || !unit.invitedAt) return false;
  return daysBetween(toLocalDate(unit.invitedAt, tz), toLocalDate(now, tz)) >= 10;
}

export function unitAgeDays(unit: Pick<Unit, "invitedAt">, now: Date, tz: string): number | null {
  if (!unit.invitedAt) return null;
  return daysBetween(toLocalDate(unit.invitedAt, tz), toLocalDate(now, tz));
}

export function isOverdue(unit: Pick<Unit, "status" | "pickupBy">, now: Date): boolean {
  return !["picked_up", "unassigned"].includes(unit.status) && !!unit.pickupBy && now > unit.pickupBy;
}

export function isReleasable(
  unit: Pick<Unit, "status" | "bookBy">,
  settings: ShowroomCtx["settings"],
  now: Date,
): boolean {
  if (!settings.release_rule_enabled) return false;
  return unit.status === "invited" && !!unit.bookBy && now > unit.bookBy;
}
