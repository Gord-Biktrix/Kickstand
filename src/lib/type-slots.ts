/**
 * Open times for a standard booking type (test ride, service, video call…). The bike pickup has its own
 * engine (capacity.ts / availability.ts); this one is simpler: the type's weekly hours cut into starts every
 * `slotStepMin`, a start offered only if the whole appointment fits inside the opening range, it is at least
 * `noticeMin` away and no more than `horizonDays` ahead, and fewer than `capacity` bookings of this type
 * overlap it (each booking blocks its length plus the type's buffer). Pure: the DB wrapper is at the bottom.
 */
import { and, eq, gte, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { bookings, capacityOverrides, staffUsers, type BookingType } from "@/db/schema";
import { effectiveHours, type WeeklyHours } from "./booking-types";
import type { ShowroomCtx } from "./showroom";
import { addLocalDays, dateRange, localToUtc, minutesToTime, timeToMinutes, toLocalDate, weekdayOf, type LocalDate } from "./time";

export type TypeSlot = { time: string; startsAt: Date; endsAt: Date; remaining: number };
export type TypeDay = { date: LocalDate; slots: TypeSlot[] };
export type Busy = { startsAt: Date; endsAt: Date };

export type SlotType = Pick<BookingType, "durationMin" | "bufferMin" | "slotStepMin" | "noticeMin" | "horizonDays"> & { hours: WeeklyHours };

export function typeSlots(args: {
  type: SlotType;
  tz: string;
  now: Date;
  capacity: number;
  busy: Busy[];
  from?: LocalDate;
  to?: LocalDate;
  /** Dates the store is closed (Settings › Availability › Closed days): nothing is offered on them. */
  closed?: ReadonlySet<LocalDate>;
}): TypeDay[] {
  const { type, tz, now, capacity } = args;
  const today = toLocalDate(now, tz);
  const from = args.from && args.from > today ? args.from : today;
  const last = addLocalDays(today, type.horizonDays);
  const to = args.to && args.to < last ? args.to : last;
  if (to < from) return [];
  const earliest = now.getTime() + type.noticeMin * 60_000;
  const bufferMs = type.bufferMin * 60_000;
  const busy = args.busy.map((b) => ({ s: b.startsAt.getTime(), e: b.endsAt.getTime() + bufferMs }));
  const out: TypeDay[] = [];
  for (const date of dateRange(from, to)) {
    if (args.closed?.has(date)) continue;
    const ranges = type.hours[String(weekdayOf(date))] ?? [];
    const slots: TypeSlot[] = [];
    for (const [open, close] of ranges) {
      const end = timeToMinutes(close);
      for (let m = timeToMinutes(open); m + type.durationMin <= end; m += type.slotStepMin) {
        const time = minutesToTime(m);
        const startsAt = localToUtc(date, time, tz);
        if (startsAt.getTime() < earliest) continue;
        const endsAt = new Date(startsAt.getTime() + type.durationMin * 60_000);
        const s = startsAt.getTime();
        const e = endsAt.getTime() + bufferMs;
        const overlapping = busy.filter((b) => b.s < e && b.e > s).length;
        if (overlapping >= capacity) continue;
        slots.push({ time, startsAt, endsAt, remaining: capacity - overlapping });
      }
    }
    if (slots.length) out.push({ date, slots });
  }
  return out;
}

/** Is this exact start offered right now? Used when a booking is confirmed, under the type's lock. */
export function findSlot(days: TypeDay[], startsAt: Date): TypeSlot | null {
  const t = startsAt.getTime();
  for (const d of days) for (const s of d.slots) if (s.startsAt.getTime() === t) return s;
  return null;
}

// ---- Database ---------------------------------------------------------------------------------

/** How many bookings of this type can overlap: the bench number, or one per active staff member in the profile. */
export async function typeCapacity(dbx: DbOrTx, showroom: ShowroomCtx, type: BookingType): Promise<number> {
  if (type.capacityMode === "bench") return type.benchCapacity;
  const [{ n }] = await dbx
    .select({ n: sql<number>`count(*)::int` })
    .from(staffUsers)
    .where(and(eq(staffUsers.active, true), or(eq(staffUsers.showroomId, showroom.id), sql`${showroom.id} = any(${staffUsers.extraShowroomIds})`)));
  return Math.max(1, n);
}

export async function busyFor(dbx: DbOrTx, typeId: string, from: Date, to: Date, exceptBookingId?: string): Promise<Busy[]> {
  return dbx
    .select({ startsAt: bookings.startsAt, endsAt: bookings.endsAt })
    .from(bookings)
    .where(
      and(
        eq(bookings.bookingTypeId, typeId),
        inArray(bookings.status, ["booked"]),
        lt(bookings.startsAt, to),
        gte(bookings.endsAt, new Date(from.getTime() - 24 * 3600_000)),
        exceptBookingId ? ne(bookings.id, exceptBookingId) : undefined,
      ),
    );
}

export async function getTypeAvailability(
  dbx: DbOrTx,
  args: { showroom: ShowroomCtx; type: BookingType; now?: Date; from?: LocalDate; to?: LocalDate; exceptBookingId?: string },
): Promise<TypeDay[]> {
  const now = args.now ?? new Date();
  const tz = args.showroom.timezone;
  const horizonEnd = localToUtc(addLocalDays(toLocalDate(now, tz), args.type.horizonDays + 1), "00:00", tz);
  const today = toLocalDate(now, tz);
  const [capacity, busy, closed] = await Promise.all([
    typeCapacity(dbx, args.showroom, args.type),
    busyFor(dbx, args.type.id, now, horizonEnd, args.exceptBookingId),
    closedDates(dbx, args.showroom.id, today, addLocalDays(today, args.type.horizonDays + 1)),
  ]);
  const hours = effectiveHours(args.type, args.showroom.bookingHours as WeeklyHours);
  return typeSlots({ type: { ...args.type, hours }, tz, now, capacity, busy, from: args.from, to: args.to, closed });
}

/**
 * The store's closed dates in a range. A closed day is a date override with no pickup capacity (Settings ›
 * Availability › Closed days, or "Closed" in Settings › Capacity): it closes booking types as well as pickups.
 */
export async function closedDates(dbx: DbOrTx, showroomId: string, from: LocalDate, to: LocalDate): Promise<Set<LocalDate>> {
  const rows = await dbx
    .select({ onDate: capacityOverrides.onDate })
    .from(capacityOverrides)
    .where(and(eq(capacityOverrides.showroomId, showroomId), eq(capacityOverrides.capacity, 0), gte(capacityOverrides.onDate, from), lte(capacityOverrides.onDate, to)));
  return new Set(rows.map((r) => r.onDate));
}
