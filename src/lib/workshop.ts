import { and, asc, between, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import { appointments, bookings, bookingTypes, orders, units, type Appointment, type Booking, type BookingType, type Order, type Unit } from "@/db/schema";
import { buildDeadline } from "./build-schedule";
import { effectiveCapacity, type OverrideLike, type RuleLike } from "./capacity";
import { getCapacityConfig } from "./showroom";
import type { ShowroomCtx } from "./showroom";
import { addLocalDays, endOfLocalDay, localToUtc, toLocalDate, type LocalDate } from "./time";

/**
 * The Workshop board: every job on the bench, with the time it has to start.
 *
 *   ready by = when the customer needs it (build deadline for a pickup, end of the appointment for a repair)
 *   start by = ready by − how long the job takes
 *
 * Builds take `settings.build_minutes`; repairs take the service type's duration. A job is late when
 * it hasn't started by its start-by (to do) or isn't done by its ready-by (in progress).
 */
export type JobColumn = "todo" | "doing" | "ready";

export type WorkshopJob = {
  id: string;
  kind: "build" | "repair";
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
};

type BuildInput = { appointment: Pick<Appointment, "onDate" | "startsAt">; unit: Pick<Unit, "id" | "status" | "model" | "boxTag" | "lsWorkorderId">; order: Pick<Order, "customerName"> | null };
type RepairInput = { booking: Pick<Booking, "id" | "startsAt" | "endsAt" | "customerName" | "lsWorkorderId">; type: Pick<BookingType, "name" | "durationMin"> };

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
  };
}

/** A repair is worked on while the customer's appointment runs: it starts at drop-off and is ready at the end. */
export function repairJob(r: RepairInput, now: Date): WorkshopJob {
  const { booking, type } = r;
  const column: JobColumn = now >= booking.startsAt ? "doing" : "todo";
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
    late: column === "doing" && now > booking.endsAt,
    unitId: null,
    bookingId: booking.id,
    tag: null,
    workorderId: booking.lsWorkorderId,
    href: `/app/bookings/${booking.id}`,
  };
}

export function sortJobs(jobs: WorkshopJob[]): WorkshopJob[] {
  return [...jobs].sort((a, b) => a.startBy.getTime() - b.startBy.getTime() || a.visitAt.getTime() - b.visitAt.getTime());
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
  const repairs = repairRows.map((r) => repairJob(r, now));

  return sortJobs([...builds, ...repairs]);
}
