import { and, asc, between, desc, eq, gte, inArray, lt, lte, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { appointments, events, orders, units, type Appointment, type Order, type Unit } from "@/db/schema";
import { buildDeadline } from "./build-schedule";
import { effectiveCapacity } from "./capacity";
import { callDue, isOverdue, unitAgeDays } from "./clock";
import { getCapacityConfig, type ShowroomCtx } from "./showroom";
import { storageDueCents } from "./storage";
import { addLocalDays, dateRange, toLocalDate, type LocalDate } from "./time";
import { hashToken } from "./tokens";
import { waitlistFor } from "./units";

const ACTIVE_STATUSES = ["received", "invited", "booked", "building", "ready"] as const;

export type UnitView = { unit: Unit; order: Order | null; appointment: Appointment | null };

export async function getUnitByToken(dbx: Db, token: string, now = new Date()): Promise<UnitView | null> {
  if (!token || token.length > 128) return null;
  const [unit] = await dbx.select().from(units).where(eq(units.tokenHash, hashToken(token))).limit(1);
  if (!unit) return null;
  if (unit.status === "picked_up" && unit.pickedUpAt && now.getTime() - unit.pickedUpAt.getTime() > 30 * 86_400_000) {
    return null;
  }
  return hydrate(dbx, unit);
}

export async function getUnitView(dbx: Db, unitId: string): Promise<UnitView | null> {
  const [unit] = await dbx.select().from(units).where(eq(units.id, unitId)).limit(1);
  return unit ? hydrate(dbx, unit) : null;
}

async function hydrate(dbx: Db, unit: Unit): Promise<UnitView> {
  const [order, appointment] = await Promise.all([
    unit.orderId
      ? dbx.select().from(orders).where(eq(orders.id, unit.orderId)).limit(1).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    dbx
      .select()
      .from(appointments)
      .where(and(eq(appointments.unitId, unit.id), eq(appointments.status, "booked")))
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);
  return { unit, order, appointment };
}

export type TodayRow = UnitView & { appointment: Appointment; storageDueCents: number };

export async function todayAppointments(dbx: Db, showroom: ShowroomCtx, date: LocalDate, now = new Date()): Promise<TodayRow[]> {
  const rows = await dbx
    .select({ appointment: appointments, unit: units, order: orders })
    .from(appointments)
    .innerJoin(units, eq(units.id, appointments.unitId))
    .leftJoin(orders, eq(orders.id, units.orderId))
    .where(and(eq(appointments.showroomId, showroom.id), eq(appointments.onDate, date), eq(appointments.status, "booked")))
    .orderBy(asc(appointments.startsAt));
  return rows.map((r) => ({
    ...r,
    storageDueCents: storageDueCents(r.unit, r.order?.termsVersion ?? 1, showroom.settings, now, showroom.timezone),
  }));
}

export type BuildRow = UnitView & { appointment: Appointment; buildBy: LocalDate; buildAt: Date | null; due: boolean };

export async function buildBoard(dbx: Db, showroom: ShowroomCtx, now = new Date()) {
  const today = toLocalDate(now, showroom.timezone);
  const { rules, overrides } = await getCapacityConfig(dbx, showroom.id);
  const withAppt = await dbx
    .select({ appointment: appointments, unit: units, order: orders })
    .from(appointments)
    .innerJoin(units, eq(units.id, appointments.unitId))
    .leftJoin(orders, eq(orders.id, units.orderId))
    .where(
      and(
        eq(appointments.showroomId, showroom.id),
        eq(appointments.status, "booked"),
        inArray(units.status, ["booked", "building", "ready"]),
      ),
    )
    .orderBy(asc(appointments.startsAt));
  const decorate = (r: (typeof withAppt)[number]): BuildRow => {
    const d = buildDeadline(showroom, r.appointment, rules, overrides);
    return { ...r, buildBy: d.date, buildAt: d.at, due: d.date <= today };
  };
  const toBuild = withAppt.filter((r) => r.unit.status === "booked").map(decorate);
  const built = withAppt.filter((r) => r.unit.status !== "booked").map(decorate);
  const needsRebooking = await dbx
    .select({ unit: units, order: orders })
    .from(units)
    .leftJoin(orders, eq(orders.id, units.orderId))
    .where(
      and(
        eq(units.showroomId, showroom.id),
        inArray(units.status, ["building", "ready"]),
        sql`not exists (select 1 from appointments a where a.unit_id = ${units.id} and a.status = 'booked')`,
      ),
    )
    .orderBy(asc(units.pickupBy));
  return { toBuild, built, needsRebooking: needsRebooking.map((r) => ({ ...r, appointment: null })) };
}

export async function receivedNotInvited(dbx: Db, showroom: ShowroomCtx) {
  return dbx
    .select({ unit: units, order: orders })
    .from(units)
    .leftJoin(orders, eq(orders.id, units.orderId))
    .where(and(eq(units.showroomId, showroom.id), eq(units.status, "received")))
    .orderBy(asc(units.receivedAt));
}

/** Detached boxes physically on the shelf with no customer (after a defer or release). */
export async function unassignedUnits(dbx: Db, showroom: ShowroomCtx) {
  return dbx.select().from(units).where(and(eq(units.showroomId, showroom.id), eq(units.status, "unassigned"))).orderBy(asc(units.updatedAt));
}

export async function searchOrders(dbx: Db, showroom: ShowroomCtx, q: string, limit = 20) {
  const term = `%${q.trim()}%`;
  const rows = await dbx
    .select({ order: orders, unit: units })
    .from(orders)
    .leftJoin(units, and(eq(units.orderId, orders.id), inArray(units.status, [...ACTIVE_STATUSES])))
    .where(
      and(
        eq(orders.showroomId, showroom.id),
        inArray(orders.status, ["open", "deferred"]),
        q.trim()
          ? or(
              sql`${orders.customerName} ilike ${term}`,
              sql`${orders.orderRef} ilike ${term}`,
              sql`${orders.customerPhone} ilike ${term}`,
              sql`${orders.customerEmail} ilike ${term}`,
              sql`${orders.model} ilike ${term}`,
            )
          : undefined,
      ),
    )
    .orderBy(desc(orders.status), asc(orders.orderDate))
    .limit(limit);
  return rows;
}

export type WatchRow = UnitView & {
  age: number | null;
  callDue: boolean;
  overdue: boolean;
  storageDueCents: number;
  releasable: boolean;
  waitlistMatches: Order[];
};

export async function watchlist(dbx: Db, showroom: ShowroomCtx, now = new Date()) {
  const tz = showroom.timezone;
  const s = showroom.settings;
  const today = toLocalDate(now, tz);
  const weekAhead = addLocalDays(today, 7);

  const active = await dbx
    .select({ unit: units, order: orders })
    .from(units)
    .leftJoin(orders, eq(orders.id, units.orderId))
    .where(and(eq(units.showroomId, showroom.id), notInArray(units.status, ["picked_up", "unassigned", "received"])))
    .orderBy(asc(units.invitedAt));
  const activeAppts = await dbx
    .select()
    .from(appointments)
    .where(and(eq(appointments.showroomId, showroom.id), eq(appointments.status, "booked")));
  const apptByUnit = new Map(activeAppts.map((a) => [a.unitId, a]));

  const waitlist = await waitlistFor(dbx, showroom.id);
  const norm = (x: string | null) => (x ?? "").trim().toLowerCase();

  const rows: WatchRow[] = active.map(({ unit, order }) => {
    const appointment = apptByUnit.get(unit.id) ?? null;
    const releasable =
      s.release_rule_enabled && unit.status === "invited" && !!unit.bookBy && now > unit.bookBy && !appointment;
    const matches = releasable
      ? waitlist.filter(
          (o) => norm(o.model) === norm(unit.model) && norm(o.size) === norm(unit.size) && norm(o.colour) === norm(unit.colour),
        )
      : [];
    return {
      unit,
      order,
      appointment,
      age: unitAgeDays(unit, now, tz),
      callDue: callDue(unit, now, tz),
      overdue: isOverdue(unit, now),
      storageDueCents: storageDueCents(unit, order?.termsVersion ?? 1, s, now, tz),
      releasable,
      waitlistMatches: matches,
    };
  });

  const unbooked7 = rows.filter((r) => r.unit.status === "invited" && (r.age ?? 0) >= 7 && !r.overdue);
  const holdEnding = rows.filter(
    (r) => r.unit.status === "invited" && r.unit.pickupBy && toLocalDate(r.unit.pickupBy, tz) >= today && toLocalDate(r.unit.pickupBy, tz) <= weekAhead,
  );
  const overdue = rows.filter((r) => r.overdue);
  const releasable = rows.filter((r) => r.releasable);

  const unrecorded = await dbx
    .select({ appointment: appointments, unit: units, order: orders })
    .from(appointments)
    .innerJoin(units, eq(units.id, appointments.unitId))
    .leftJoin(orders, eq(orders.id, units.orderId))
    .where(and(eq(appointments.showroomId, showroom.id), eq(appointments.status, "booked"), lt(appointments.onDate, today)))
    .orderBy(asc(appointments.startsAt));

  const failures = await dbx
    .select({ event: events, unit: units, order: orders })
    .from(events)
    .leftJoin(units, eq(units.id, events.unitId))
    .leftJoin(orders, eq(orders.id, events.orderId))
    .where(and(eq(events.showroomId, showroom.id), eq(events.klaviyoStatus, "failed"), gte(events.createdAt, new Date(now.getTime() - 14 * 86_400_000))))
    .orderBy(desc(events.createdAt))
    .limit(50);

  // Day-closed conflicts: booked appointments on days whose effective capacity is now 0 or below bookings.
  const { rules, overrides } = await getCapacityConfig(dbx, showroom.id, today);
  const byDate = new Map<string, typeof activeAppts>();
  for (const a of activeAppts) {
    if (a.onDate < today) continue;
    byDate.set(a.onDate, [...(byDate.get(a.onDate) ?? []), a]);
  }
  const dayConflicts: { date: LocalDate; capacity: number; booked: number; appointments: typeof activeAppts }[] = [];
  for (const [date, list] of byDate) {
    const day = effectiveCapacity(date, rules, overrides);
    if (day.closed || list.length > day.capacity) {
      dayConflicts.push({ date, capacity: day.capacity, booked: list.length, appointments: list });
    }
  }
  dayConflicts.sort((a, b) => (a.date < b.date ? -1 : 1));

  return { unbooked7, holdEnding, overdue, releasable, unrecorded, failures, dayConflicts };
}

export async function unitTimeline(dbx: Db, unitId: string) {
  return dbx.select().from(events).where(eq(events.unitId, unitId)).orderBy(desc(events.createdAt));
}

export async function orderTimeline(dbx: Db, orderId: string) {
  return dbx.select().from(events).where(eq(events.orderId, orderId)).orderBy(desc(events.createdAt));
}

export async function appointmentHistory(dbx: Db, unitId: string) {
  return dbx.select().from(appointments).where(eq(appointments.unitId, unitId)).orderBy(desc(appointments.startsAt));
}

export async function unitsForOrder(dbx: Db, orderId: string) {
  return dbx.select().from(units).where(eq(units.orderId, orderId)).orderBy(desc(units.receivedAt));
}

export async function bookedCountsByDate(dbx: Db, showroomId: string, from: LocalDate, to: LocalDate) {
  const rows = await dbx
    .select({ onDate: appointments.onDate, n: sql<number>`count(*)::int` })
    .from(appointments)
    .where(and(eq(appointments.showroomId, showroomId), eq(appointments.status, "booked"), gte(appointments.onDate, from), lte(appointments.onDate, to)))
    .groupBy(appointments.onDate);
  return new Map(rows.map((r) => [r.onDate, r.n]));
}

/** §11 pilot metrics for units invited or picked up within [from, to]. */
export async function pilotMetrics(dbx: Db, showroom: ShowroomCtx, from: LocalDate, to: LocalDate) {
  const sid = showroom.id;
  const tz = showroom.timezone;
  const [floor] = await dbx.execute<{ avg_floor_days: number | null; units: number }>(sql`
    with ready as (
      select unit_id, min(created_at) as ready_at from events
      where showroom_id = ${sid} and type = 'ready' group by unit_id
    )
    select avg(greatest(0, (u.picked_up_at at time zone ${tz})::date - (r.ready_at at time zone ${tz})::date - 1))::float as avg_floor_days,
           count(*)::int as units
    from units u join ready r on r.unit_id = u.id
    where u.showroom_id = ${sid} and u.status = 'picked_up'
      and (u.picked_up_at at time zone ${tz})::date between ${from} and ${to}
  `);
  const [boxDays] = await dbx.execute<{ median_days: number | null; units: number }>(sql`
    select percentile_cont(0.5) within group (order by extract(epoch from (picked_up_at - received_at))/86400)::float as median_days,
           count(*)::int as units
    from units where showroom_id = ${sid} and status = 'picked_up'
      and (picked_up_at at time zone ${tz})::date between ${from} and ${to}
  `);
  const [early] = await dbx.execute<{ invited: number; within_72: number }>(sql`
    with first_booking as (
      select unit_id, min(created_at) as booked_at from appointments where showroom_id = ${sid} group by unit_id
    )
    select count(*)::int as invited,
           count(*) filter (where fb.booked_at is not null and fb.booked_at <= u.invited_at + interval '72 hours')::int as within_72
    from units u left join first_booking fb on fb.unit_id = u.id
    where u.showroom_id = ${sid} and u.invited_at is not null
      and (u.invited_at at time zone ${tz})::date between ${from} and ${to}
  `);
  const [noShow] = await dbx.execute<{ reached: number; no_shows: number }>(sql`
    select count(*)::int as reached,
           count(*) filter (where status = 'no_show')::int as no_shows
    from appointments where showroom_id = ${sid}
      and on_date between ${from} and ${to} and on_date <= (now() at time zone ${tz})::date
      and status in ('completed','no_show')
  `);
  const [storage] = await dbx.execute<{ collected: number; waived: number }>(sql`
    select coalesce(sum(storage_collected_cents),0)::int as collected, coalesce(sum(storage_waived_cents),0)::int as waived
    from units where showroom_id = ${sid} and status = 'picked_up'
      and (picked_up_at at time zone ${tz})::date between ${from} and ${to}
  `);
  const detaches = await dbx.execute<{ reason: string; n: number; avg_hours_to_reassign: number | null }>(sql`
    with d as (
      select e.unit_id, e.created_at, e.payload->>'reason' as reason,
        (select min(r.created_at) from events r where r.unit_id = e.unit_id and r.type = 'unit_reassigned' and r.created_at > e.created_at) as reassigned_at
      from events e where e.showroom_id = ${sid} and e.type = 'unit_detached'
        and (e.created_at at time zone ${tz})::date between ${from} and ${to}
    )
    select reason, count(*)::int as n, avg(extract(epoch from (reassigned_at - created_at))/3600)::float as avg_hours_to_reassign
    from d group by reason
  `);
  const saturdays = await dbx.execute<{ on_date: string; booked: number; days_to_fill: number | null }>(sql`
    with sat as (
      select a.on_date, count(*)::int as booked, min(a.created_at) as first_booking, max(a.created_at) as last_booking
      from appointments a where a.showroom_id = ${sid} and a.status in ('booked','completed','no_show')
        and extract(dow from a.on_date) = 6 and a.on_date between ${from} and ${to}
      group by a.on_date
    )
    select on_date::text, booked, extract(epoch from (last_booking - first_booking))/86400::float as days_to_fill from sat order by on_date
  `);
  const utilisation = await dbx.execute<{ dow: number; booked: number; days: number }>(sql`
    select extract(dow from on_date)::int as dow, count(*)::int as booked, count(distinct on_date)::int as days
    from appointments where showroom_id = ${sid} and status in ('booked','completed','no_show') and on_date between ${from} and ${to}
    group by 1 order by 1
  `);
  const [messages] = await dbx.execute<{ sent: number; failed: number }>(sql`
    select count(*) filter (where klaviyo_status = 'sent')::int as sent, count(*) filter (where klaviyo_status = 'failed')::int as failed
    from events where showroom_id = ${sid} and type like 'msg_%' and (created_at at time zone ${tz})::date between ${from} and ${to}
  `);
  const [invites] = await dbx.execute<{ invites: number }>(sql`
    select count(*)::int as invites from events where showroom_id = ${sid} and type in ('invite_sent','unit_reassigned')
      and (created_at at time zone ${tz})::date between ${from} and ${to}
  `);
  return { floor, boxDays, early, noShow, storage, detaches: [...detaches], saturdays: [...saturdays], utilisation: [...utilisation], messages, invites };
}

export async function exportRows(dbx: Db, showroom: ShowroomCtx) {
  const unitRows = await dbx
    .select({ unit: units, order: orders })
    .from(units)
    .leftJoin(orders, eq(orders.id, units.orderId))
    .where(eq(units.showroomId, showroom.id))
    .orderBy(asc(units.receivedAt));
  const apptRows = await dbx
    .select()
    .from(appointments)
    .where(eq(appointments.showroomId, showroom.id))
    .orderBy(asc(appointments.startsAt));
  return { unitRows, apptRows };
}

// ---- Schedule tab ----------------------------------------------------------

export type ScheduleRow = UnitView & { appointment: Appointment; buildBy: LocalDate; buildAt: Date | null };
export type ScheduleDay = { date: LocalDate; closed: boolean; capacity: number; pickups: ScheduleRow[]; builds: ScheduleRow[] };

/**
 * Every booked pickup whose pickup day OR build day falls in [from, to], laid out per day twice:
 * `pickups` by appointment day, `builds` by assembly deadline (src/lib/build-schedule.ts).
 */
export async function weekSchedule(dbx: Db, showroom: ShowroomCtx, from: LocalDate, to: LocalDate): Promise<ScheduleDay[]> {
  const { rules, overrides } = await getCapacityConfig(dbx, showroom.id);
  // Build days precede pickup days by at most a few days; widen the appointment range accordingly.
  const rows = await dbx
    .select({ appointment: appointments, unit: units, order: orders })
    .from(appointments)
    .innerJoin(units, eq(units.id, appointments.unitId))
    .leftJoin(orders, eq(orders.id, units.orderId))
    .where(
      and(
        eq(appointments.showroomId, showroom.id),
        eq(appointments.status, "booked"),
        between(appointments.onDate, from, addLocalDays(to, 7)),
      ),
    )
    .orderBy(asc(appointments.startsAt));
  const decorated: ScheduleRow[] = rows.map((r) => {
    const d = buildDeadline(showroom, r.appointment, rules, overrides);
    return { ...r, buildBy: d.date, buildAt: d.at };
  });
  return dateRange(from, to).map((date) => {
    const day = effectiveCapacity(date, rules, overrides);
    return {
      date,
      closed: day.closed,
      capacity: day.capacity,
      pickups: decorated.filter((r) => r.appointment.onDate === date),
      builds: decorated
        .filter((r) => r.buildBy === date)
        .sort((a, b) => (a.buildAt?.getTime() ?? 0) - (b.buildAt?.getTime() ?? 0) || a.appointment.startsAt.getTime() - b.appointment.startsAt.getTime()),
    };
  });
}
