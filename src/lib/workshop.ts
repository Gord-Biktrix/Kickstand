import { and, asc, between, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import { appointments, bookings, bookingTypes, lsEmployees, lsWorkorders, lsWorkorderStatuses, orders, units, type Appointment, type Booking, type BookingType, type LsWorkorder, type Order, type Unit } from "@/db/schema";
import { buildDeadline } from "./build-schedule";
import { effectiveCapacity, type OverrideLike, type RuleLike } from "./capacity";
import { getCapacityConfig } from "./showroom";
import type { ShowroomCtx } from "./showroom";
import { addLocalDays, endOfLocalDay, localToUtc, toLocalDate, type LocalDate } from "./time";
import { columnOf, workshopColumns, type BoardColumn, type WorkshopColumns } from "./workshop-columns";
import { lightspeedWorkorderUrl } from "./workorders";

/**
 * The Workshop board: every job on the bench, with the time it has to start.
 *
 *   ready by = when the customer needs it (build deadline for a pickup, end of the appointment for a repair)
 *   start by = ready by − how long the job takes
 *
 * Builds take `settings.build_minutes`; booked repairs take the service type's duration; other Lightspeed
 * work orders take `settings.repair_minutes` before their due time. A job is late when it hasn't started by
 * its start-by (to do) or isn't done by its ready-by (in progress). Waiting on parts is never "late".
 *
 * Every open Lightspeed work order whose status is mapped to a column (Settings › Views) is on the board too,
 * so walk-ins and floor-bike repairs written at the counter show up beside Kickstand's own builds and bookings.
 * A work order Kickstand made for a bike or a booking isn't shown twice: it rides on that job instead.
 */
export type JobColumn = BoardColumn;

export type WorkshopJob = {
  id: string;
  /** floor = the shop's own bike (no customer). */
  kind: "build" | "repair" | "floor";
  column: JobColumn;
  title: string;
  customer: string | null;
  minutes: number;
  startBy: Date;
  readyBy: Date;
  /** The customer's visit: pickup slot for a build, drop-off for a repair. */
  visitAt: Date;
  late: boolean;
  /** Build: the unit (for the Build / Ready buttons). Repair: the booking. */
  unitId: string | null;
  bookingId: string | null;
  tag: string | null;
  workorderId: string | null;
  href: string;
  /** Lightspeed's status name and the mechanic on the work order, when there is one. */
  status: string | null;
  mechanicId: string | null;
  mechanic: string | null;
  /** A Lightspeed work order with no due date: sorted last, never late. */
  noDate: boolean;
  /** Kickstand's own job (bike pickup or booking) or a work order written in Lightspeed. */
  source: "kickstand" | "lightspeed";
  /** A service booking whose bike hasn't been checked in yet. */
  notHereYet: boolean;
  note: string | null;
};

type BuildInput = { appointment: Pick<Appointment, "onDate" | "startsAt">; unit: Pick<Unit, "id" | "status" | "model" | "boxTag" | "lsWorkorderId">; order: Pick<Order, "customerName"> | null };
type RepairInput = { booking: Pick<Booking, "id" | "startsAt" | "endsAt" | "customerName" | "lsWorkorderId" | "status">; type: Pick<BookingType, "name" | "durationMin"> };

/** Ready-by for a build: the deadline instant, or (in "pickup" mode, date only) the close of that day's pickup window. */
export function buildReadyBy(showroom: ShowroomCtx, appt: BuildInput["appointment"], rules: RuleLike[], overrides: OverrideLike[]): Date {
  const d = buildDeadline(showroom, appt, rules, overrides);
  if (d.at) return d.at;
  const day = effectiveCapacity(d.date, rules, overrides);
  return day.closed || day.windowEnd === "00:00" ? endOfLocalDay(d.date, showroom.timezone) : localToUtc(d.date, day.windowEnd, showroom.timezone);
}

export function buildJob(showroom: ShowroomCtx, r: BuildInput, readyBy: Date, now: Date): WorkshopJob {
  const minutes = showroom.settings.build_minutes;
  const startBy = new Date(readyBy.getTime() - minutes * 60_000);
  const column: JobColumn = r.unit.status === "ready" ? "ready" : r.unit.status === "building" ? "doing" : "todo";
  const late = column === "todo" ? now > startBy : column === "doing" ? now > readyBy : false;
  return {
    id: `u:${r.unit.id}`,
    kind: "build",
    column,
    title: r.unit.model,
    customer: r.order?.customerName ?? null,
    minutes,
    startBy,
    readyBy,
    visitAt: r.appointment.startsAt,
    late,
    unitId: r.unit.id,
    bookingId: null,
    tag: r.unit.boxTag,
    workorderId: r.unit.lsWorkorderId,
    href: `/app/units/${r.unit.id}`,
    status: null,
    mechanicId: null,
    mechanic: null,
    noDate: false,
    source: "kickstand",
    note: null,
    notHereYet: false,
  };
}

/**
 * A booked repair: the bike comes in at the appointment and is worked on during it. Until staff check it in it
 * waits in To do as "not here yet"; once checked in, its work order's status decides the column (withWorkorder).
 */
export function repairJob(r: RepairInput, now: Date): WorkshopJob {
  const { booking, type } = r;
  const arrived = booking.status === "completed";
  const column: JobColumn = "todo";
  return {
    id: `b:${booking.id}`,
    kind: "repair",
    column,
    title: type.name,
    customer: booking.customerName,
    minutes: type.durationMin,
    startBy: booking.startsAt,
    readyBy: booking.endsAt,
    visitAt: booking.startsAt,
    late: arrived && now > booking.startsAt,
    unitId: null,
    bookingId: booking.id,
    tag: null,
    workorderId: booking.lsWorkorderId,
    href: `/app/bookings/${booking.id}`,
    status: null,
    mechanicId: null,
    mechanic: null,
    noDate: false,
    source: "kickstand",
    note: null,
    notHereYet: !arrived,
  };
}

type WoInput = Pick<LsWorkorder, "id" | "statusId" | "customerName" | "item" | "note" | "employeeId" | "etaOut" | "timeIn">;

/** A work order written in Lightspeed (walk-in, floor bike, build made at the counter). */
export function workorderJob(
  w: WoInput,
  ctx: { column: BoardColumn; status: string; mechanic: string | null; repairMinutes: number },
  now: Date,
): WorkshopJob {
  const { column } = ctx;
  const noDate = !w.etaOut;
  const readyBy = w.etaOut ?? new Date(8.64e15);
  const minutes = ctx.repairMinutes;
  const startBy = noDate ? readyBy : new Date(readyBy.getTime() - minutes * 60_000);
  const kind: WorkshopJob["kind"] = /build/i.test(ctx.status) ? "build" : !w.customerName || /floor/i.test(ctx.status) ? "floor" : "repair";
  const firstLine = w.note.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const late = noDate ? false : column === "todo" ? now > startBy : column === "doing" ? now > readyBy : false;
  return {
    id: `w:${w.id}`,
    kind,
    column,
    title: w.item || firstLine || `Work order #${w.id}`,
    customer: w.customerName || null,
    minutes,
    startBy,
    readyBy,
    visitAt: w.timeIn ?? readyBy,
    late,
    unitId: null,
    bookingId: null,
    tag: null,
    workorderId: w.id,
    href: lightspeedWorkorderUrl(w.id),
    status: ctx.status,
    mechanicId: w.employeeId,
    mechanic: ctx.mechanic,
    noDate,
    source: "lightspeed",
    note: w.item && firstLine ? firstLine : null,
    notHereYet: false,
  };
}

export function sortJobs(jobs: WorkshopJob[]): WorkshopJob[] {
  return [...jobs].sort((a, b) => a.startBy.getTime() - b.startBy.getTime() || a.visitAt.getTime() - b.visitAt.getTime());
}

/** A Kickstand job whose work order is open in Lightspeed takes its column, status and mechanic from it. */
export function withWorkorder(job: WorkshopJob, w: WoInput | undefined, ctx: { columns: WorkshopColumns; statusName: (id: number) => string; mechanicName: (id: string | null) => string | null }, now: Date): WorkshopJob {
  if (!w) return job;
  const status = ctx.statusName(w.statusId);
  const mechanic = ctx.mechanicName(w.employeeId);
  // Bikes keep Kickstand's own build status (Build / Ready buttons); a booked repair follows Lightspeed.
  const col = job.kind === "repair" ? columnOf(ctx.columns, w.statusId) : null;
  const column = col ?? job.column;
  const late = job.notHereYet ? false : column === "todo" ? now > job.startBy : column === "doing" ? now > job.readyBy : false;
  return { ...job, column, late, status, mechanicId: w.employeeId, mechanic };
}

/**
 * Jobs for the board: builds for booked pickups from today up to `days` ahead (plus any overdue ones still
 * waiting), every bike being built or ready for a pickup that hasn't happened, and service bookings from
 * today up to `days` ahead. Parts-only pickups aren't built, so they're left out.
 */
export async function workshopJobs(dbx: Db, showroom: ShowroomCtx, now = new Date(), days = 7): Promise<WorkshopJob[]> {
  const tz = showroom.timezone;
  const today = toLocalDate(now, tz);
  const until: LocalDate = addLocalDays(today, days);
  const { rules, overrides } = await getCapacityConfig(dbx, showroom.id);

  const pickupRows = await dbx
    .select({ appointment: appointments, unit: units, order: orders })
    .from(appointments)
    .innerJoin(units, eq(units.id, appointments.unitId))
    .leftJoin(orders, eq(orders.id, units.orderId))
    .where(
      and(
        eq(appointments.showroomId, showroom.id),
        eq(appointments.status, "booked"),
        inArray(units.status, ["booked", "building", "ready"]),
        ne(units.kind, "parts"),
      ),
    )
    .orderBy(asc(appointments.startsAt));

  const builds = pickupRows
    .map((r) => buildJob(showroom, r, buildReadyBy(showroom, r.appointment, rules, overrides), now))
    // To-do builds only once their ready-by falls inside the window; started or ready ones always show.
    .filter((j) => j.column !== "todo" || toLocalDate(j.readyBy, tz) <= until);

  const repairRows = await dbx
    .select({ booking: bookings, type: bookingTypes })
    .from(bookings)
    .innerJoin(bookingTypes, eq(bookingTypes.id, bookings.bookingTypeId))
    .where(
      and(
        eq(bookings.showroomId, showroom.id),
        eq(bookings.status, "booked"),
        eq(bookingTypes.createsWorkOrder, true),
        between(bookings.onDate, today, until),
      ),
    );
  // Lightspeed work orders (the hourly mirror), their statuses and mechanics.
  const [wos, statuses, employees] = await Promise.all([
    dbx.select().from(lsWorkorders).where(eq(lsWorkorders.showroomId, showroom.id)),
    dbx.select().from(lsWorkorderStatuses),
    dbx.select().from(lsEmployees),
  ]);
  // Checked-in service bookings stay on the board, whatever their date, until their work order is paid.
  const checkedIn = wos.length
    ? await dbx
        .select({ booking: bookings, type: bookingTypes })
        .from(bookings)
        .innerJoin(bookingTypes, eq(bookingTypes.id, bookings.bookingTypeId))
        .where(and(eq(bookings.showroomId, showroom.id), eq(bookings.status, "completed"), eq(bookingTypes.createsWorkOrder, true), inArray(bookings.lsWorkorderId, wos.map((w) => w.id))))
    : [];
  const repairs = [...repairRows, ...checkedIn].map((r) => repairJob(r, now));
  const columns = workshopColumns(showroom.settings, statuses);
  const statusById = new Map(statuses.map((st) => [st.id, st.name]));
  const nameById = new Map(employees.map((e) => [e.id, e.name]));
  const ctx = { columns, statusName: (id: number) => statusById.get(id) ?? `Status ${id}`, mechanicName: (id: string | null) => (id ? (nameById.get(id) ?? null) : null) };
  const woById = new Map(wos.map((w) => [w.id, w]));
  const kickstandJobs = [...builds, ...repairs].map((j) => withWorkorder(j, j.workorderId ? woById.get(j.workorderId) : undefined, ctx, now));

  const claimed = new Set(kickstandJobs.map((j) => j.workorderId).filter(Boolean));
  const linkedToBikes = await dbx.select({ wo: units.lsWorkorderId }).from(units).where(and(eq(units.showroomId, showroom.id), inArray(units.lsWorkorderId, wos.length ? wos.map((w) => w.id) : ["-"])));
  for (const r of linkedToBikes) if (r.wo) claimed.add(r.wo);
  const lsJobs = wos.flatMap((w) => {
    if (claimed.has(w.id) || w.unitId) return [];
    const column = columnOf(columns, w.statusId);
    if (!column) return [];
    return [workorderJob(w, { column, status: ctx.statusName(w.statusId), mechanic: ctx.mechanicName(w.employeeId), repairMinutes: showroom.settings.repair_minutes }, now)];
  });

  return sortJobs([...kickstandJobs, ...lsJobs]);
}

/** The POS job page for a board card: /app/workshop/w-10237 (Lightspeed work order) or /app/workshop/b-<booking id>. */
export function jobPath(jobId: string): string {
  return `/app/workshop/${jobId.replace(":", "-")}`;
}

export function jobIdFromPath(ref: string): string | null {
  const m = /^([wbu])-(.+)$/.exec(decodeURIComponent(ref));
  return m ? `${m[1]}:${m[2]}` : null;
}
