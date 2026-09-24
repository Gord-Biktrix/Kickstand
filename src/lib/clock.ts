import { and, eq, gte, isNotNull, lte, notInArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { appointments, dayCounters, events, orders, units, type Order, type Unit } from "@/db/schema";
import { effectiveCapacity } from "./capacity";
import { customerKey } from "./customers";
import { syncDeliveryReports } from "./delivery";
import { inviteStatus, readMessage } from "./invite-status";
import { formatMoney } from "./format";
import { logger } from "./logger";
import { baseUrl, METRIC, sendUnitMessage, type MessageOutcome } from "./messages";
import { postSlack, unbookedPingMessage } from "./slack";
import { getCapacityConfig, listShowrooms, patchShowroomSettings, type ShowroomCtx } from "./showroom";
import { syncSpecialOrders } from "./special-orders";
import { syncWorkorders } from "./workorders";
import { storageDueCents, storageEnabledFor } from "./storage";
import { addLocalDays, daysBetween, formatDateTime, formatLongDate, localHour, startOfLocalDay, toLocalDate, weekdayOf } from "./time";

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
    staffPinged: number;
    staffPingFailed: number;
  };
};

export type ClockOptions = {
  /** Tests: skip the Lightspeed special-order pull. */
  skipSpecialOrders?: boolean;
  /**
   * Wall-clock budget for the Lightspeed syncs, measured from the start of the run. Stores whose
   * sync would start after the budget is spent are skipped (and logged) so the request returns a
   * clean summary instead of being killed by the platform (Vercel Hobby: 60 s). Default 45 s.
   */
  syncBudgetMs?: number;
  now?: Date;
  /** Run the daily actions regardless of local hour (tests, manual replay). Dedupe still applies. */
  forceDaily?: boolean;
  /** Run the day-before reminders regardless of local hour. */
  forceReminders?: boolean;
  /** Tests: the Klaviyo delivery-report source (null skips the check). */
  deliveryFeed?: import("./delivery").DeliveryFeed | null;
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

/**
 * §8 — the tick. Safe to replay: every message is deduped on (unit, type, key). Runs at least once a
 * day (Vercel cron, see vercel.json) and tolerates any cadence up to hourly.
 *
 * Customer-facing work (daily actions, reminders) runs for every store first; the Lightspeed pulls
 * follow, within a time budget, so a slow special-order sync at one store can never delay or lose
 * another store's messages.
 */
export async function runClock(dbx: Db, opts: ClockOptions = {}): Promise<ClockSummary[]> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const budget = opts.syncBudgetMs ?? 45_000;
  const showrooms = await listShowrooms(dbx);
  const summaries: ClockSummary[] = [];
  for (const showroom of showrooms) summaries.push(await runClockForShowroom(dbx, showroom, now, opts));

  // Carrier delivery reports for recent messages (best-effort, bounded; see src/lib/delivery.ts).
  try {
    const d = await syncDeliveryReports(dbx, { now, feed: opts.deliveryFeed });
    if (d.customers > 0) logger.info(d, "clock: delivery reports checked");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "clock: delivery report check skipped");
  }

  // Pull new special orders and mirror open work orders from Lightspeed (best-effort; the tick must not fail on it).
  if (!opts.skipSpecialOrders) {
    for (const showroom of showrooms) {
      if (!showroom.settings.lightspeed.shop_id) continue;
      if (Date.now() - started > budget) {
        logger.warn({ showroom: showroom.slug, elapsedMs: Date.now() - started }, "clock: Lightspeed sync skipped — out of time this tick");
        continue;
      }
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
    staffPinged: 0,
    staffPingFailed: 0,
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
    const toPing: { unit: Unit; order: Order | null; age: number }[] = [];
    for (const { unit, order } of rows) {
      const age = daysBetween(toLocalDate(unit.invitedAt!, tz), today);
      if (unit.status === "invited") counts.invited++;
      else counts.booked++;
      if (unit.pickupBy && now > unit.pickupBy) counts.overdue++;
      if (s.release_rule_enabled && unit.status === "invited" && unit.bookBy && now > unit.bookBy) counts.releasable++;

      const base = { showroom, unit, order, dedupeKey: today, actor: "system" as const };
      if (unit.status === "invited") {
        // Exact days, deduped per date (as before the days became settings), so changing a setting never re-sends.
        if (s.nudge_first_days > 0 && age === s.nudge_first_days) {
          saturdayDisplay ??= await nextSaturdayRemaining(dbx, showroom, today);
          tally(await sendUnitMessage(dbx, { ...base, metric: METRIC.nudge3, extra: { remaining_saturday_display: saturdayDisplay, days_since_invite: age } }));
        } else if (s.nudge_second_days > 0 && age === s.nudge_second_days) {
          tally(await sendUnitMessage(dbx, { ...base, metric: METRIC.nudge7, extra: { days_since_invite: age } }));
        } else if (s.hold_ending_days > 0 && age === s.hold_ending_days) {
          tally(await sendUnitMessage(dbx, { ...base, metric: METRIC.holdEnding, extra: { days_since_invite: age } }));
        }
        if (s.staff_ping_days > 0 && age >= s.staff_ping_days && s.slack_webhook_url) toPing.push({ unit, order, age });
      }

      // Storage reminder every N days while the bike sits in storage (period number is the dedupe key, so a missed run catches up once).
      if (unit.storageFrom && s.storage_reminder_days > 0) {
        const period = Math.floor(daysBetween(toLocalDate(unit.storageFrom, tz), today) / s.storage_reminder_days);
        if (period >= 1) {
          tally(
            await sendUnitMessage(dbx, {
              ...base,
              dedupeKey: `storage:${period}`,
              metric: METRIC.storageReminder,
              extra: { storage_due_display: formatMoney(storageDueCents(unit, order?.termsVersion ?? 1, s, now, tz)), storage_days: period * s.storage_reminder_days },
            }),
          );
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

    // Missed follow-up: N days after a no-show, if the bike is still waiting for a new booking.
    if (s.missed_followup_days > 0) {
      const missed = await dbx
        .select({ appointment: appointments, unit: units, order: orders })
        .from(appointments)
        .innerJoin(units, eq(units.id, appointments.unitId))
        .leftJoin(orders, eq(orders.id, units.orderId))
        .where(
          and(
            eq(appointments.showroomId, showroom.id),
            eq(appointments.status, "no_show"),
            eq(units.status, "invited"),
            // A short catch-up window, so a missed run still sends but switching the feature on doesn't text old no-shows.
            gte(appointments.onDate, addLocalDays(today, -(s.missed_followup_days + 2))),
            lte(appointments.onDate, addLocalDays(today, -s.missed_followup_days)),
          ),
        );
      const seen = new Set<string>();
      for (const { appointment, unit, order } of missed) {
        if (seen.has(unit.id)) continue;
        seen.add(unit.id);
        tally(
          await sendUnitMessage(dbx, {
            showroom,
            unit,
            order,
            metric: METRIC.missedFollowUp,
            dedupeKey: appointment.id,
            extra: { slot_start_local: formatDateTime(appointment.startsAt, tz), no_show_count: unit.noShowCount },
          }),
        );
      }
    }

    for (const p of toPing) {
      const r = await pingUnbooked(dbx, showroom, p.unit, p.order, p.age);
      if (r === "sent") counts.staffPinged++;
      else if (r === "failed") counts.staffPingFailed++;
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
      // One reminder per visit and customer, not per bike (a combined pickup for a couple reminds both).
      if (appointment.groupId) {
        const key = `${appointment.groupId}:${order ? customerKey(order) : unit.id}`;
        if (remindedGroups.has(key)) continue;
        remindedGroups.add(key);
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

/**
 * One Slack message per customer, once per invite: they were invited `staff_ping_days` ago and still
 * haven't booked. The event row is the lock; a failed post removes it so the next run tries again.
 */
export async function pingUnbooked(dbx: Db, showroom: ShowroomCtx, unit: Unit, order: Order | null, age: number): Promise<"sent" | "failed" | "skipped"> {
  const webhook = showroom.settings.slack_webhook_url;
  if (!webhook || !unit.invitedAt) return "skipped";
  const tz = showroom.timezone;
  const dedupeKey = `invite:${unit.invitedAt.toISOString()}`;
  const [lock] = await dbx
    .insert(events)
    .values({ showroomId: showroom.id, unitId: unit.id, orderId: order?.id ?? null, type: "staff_pinged", actor: "system", payload: { dedupe_key: dedupeKey, channel: "slack", days: age } })
    .onConflictDoNothing()
    .returning({ id: events.id });
  if (!lock) return "skipped";

  const msgs = await dbx.select().from(events).where(and(eq(events.unitId, unit.id), sql`${events.type} like 'msg_%'`, isNotNull(events.klaviyoStatus)));
  const status = inviteStatus(unit, msgs.map(readMessage));
  const error = await postSlack(
    webhook,
    unbookedPingMessage({
      store: showroom.name,
      customer: order?.customerName ?? "Unknown customer",
      phone: order?.customerPhone ?? null,
      email: order?.customerEmail ?? null,
      bike: [unit.model, unit.colour, unit.size].filter(Boolean).join(" · "),
      boxTag: unit.boxTag,
      days: age,
      invitedOn: formatLongDate(unit.invitedAt, tz),
      inviteStatus: status ? `${status.label} — ${status.detail}` : "unknown",
      url: `${baseUrl()}/app/switch?showroom=${encodeURIComponent(showroom.slug)}&next=${encodeURIComponent(`/app/units/${unit.id}`)}`,
    }),
  );
  if (error) {
    await dbx.delete(events).where(eq(events.id, lock.id));
    return "failed";
  }
  return "sent";
}

/** Units staff should phone: invited `days` or more ago (settings.staff_ping_days; 0 = off), not yet booked. */
export function callDue(unit: Pick<Unit, "status" | "invitedAt">, now: Date, tz: string, days: number): boolean {
  if (days <= 0 || unit.status !== "invited" || !unit.invitedAt) return false;
  return daysBetween(toLocalDate(unit.invitedAt, tz), toLocalDate(now, tz)) >= days;
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
