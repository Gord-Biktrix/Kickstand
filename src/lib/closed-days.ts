/**
 * Closed days (Settings › Availability): dates a store takes no bookings at all, such as stat holidays. Stored
 * as a date override with no capacity, the same row "Closed" makes in Settings › Capacity, so a closed day stops
 * bike pickups and every booking type alike (type-slots.ts › closedDates).
 */
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { bookings, bookingTypes, capacityOverrides } from "@/db/schema";
import type { Holiday } from "./holidays";
import type { LocalDate } from "./time";

export type ClosedDay = { id: string; date: LocalDate; name: string };

export async function listClosedDays(dbx: DbOrTx, showroomId: string, from: LocalDate): Promise<ClosedDay[]> {
  const rows = await dbx
    .select({ id: capacityOverrides.id, date: capacityOverrides.onDate, note: capacityOverrides.note })
    .from(capacityOverrides)
    .where(and(eq(capacityOverrides.showroomId, showroomId), eq(capacityOverrides.capacity, 0), gte(capacityOverrides.onDate, from)))
    .orderBy(asc(capacityOverrides.onDate));
  return rows.map((r) => ({ id: r.id, date: r.date, name: r.note ?? "" }));
}

/** Close these dates (a date that already has an override becomes closed, keeping its note if this one has none). */
export async function addClosedDays(dbx: DbOrTx, showroomId: string, days: Holiday[]): Promise<void> {
  for (const d of days) {
    await dbx
      .insert(capacityOverrides)
      .values({ showroomId, onDate: d.date, capacity: 0, note: d.name || null })
      .onConflictDoUpdate({ target: [capacityOverrides.showroomId, capacityOverrides.onDate], set: { capacity: 0, ...(d.name ? { note: d.name } : {}) } });
  }
}

export async function removeClosedDay(dbx: DbOrTx, showroomId: string, id: string): Promise<ClosedDay | null> {
  const [row] = await dbx
    .delete(capacityOverrides)
    .where(and(eq(capacityOverrides.id, id), eq(capacityOverrides.showroomId, showroomId), eq(capacityOverrides.capacity, 0)))
    .returning();
  return row ? { id: row.id, date: row.onDate, name: row.note ?? "" } : null;
}

export type BookingOnClosedDay = { id: string; date: LocalDate; startsAt: Date; customer: string; type: string };

/** Bookings still on the books for closed dates, for staff to move (nothing is cancelled automatically). */
export async function bookingsOnClosedDays(dbx: DbOrTx, showroomId: string, dates: LocalDate[]): Promise<BookingOnClosedDay[]> {
  if (dates.length === 0) return [];
  return dbx
    .select({ id: bookings.id, date: bookings.onDate, startsAt: bookings.startsAt, customer: bookings.customerName, type: bookingTypes.name })
    .from(bookings)
    .innerJoin(bookingTypes, eq(bookingTypes.id, bookings.bookingTypeId))
    .where(and(eq(bookings.showroomId, showroomId), eq(bookings.status, "booked"), inArray(bookings.onDate, dates)))
    .orderBy(asc(bookings.startsAt));
}
