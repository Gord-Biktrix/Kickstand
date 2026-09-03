import { addDays, differenceInCalendarDays, format, getDay, parseISO } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/** Calendar date in the showroom's zone, as YYYY-MM-DD. Compares lexicographically. */
export type LocalDate = string;

export function toLocalDate(instant: Date, tz: string): LocalDate {
  return formatInTimeZone(instant, tz, "yyyy-MM-dd");
}

export function localHour(instant: Date, tz: string): number {
  return Number(formatInTimeZone(instant, tz, "H"));
}

/** Local wall-clock (date + HH:mm[:ss]) to an instant, honouring DST for that date. */
export function localToUtc(date: LocalDate, time: string, tz: string): Date {
  return fromZonedTime(`${date}T${normalizeTime(time)}`, tz);
}

export function startOfLocalDay(date: LocalDate, tz: string): Date {
  return localToUtc(date, "00:00:00", tz);
}

export function endOfLocalDay(date: LocalDate, tz: string): Date {
  return localToUtc(date, "23:59:59", tz);
}

export function addLocalDays(date: LocalDate, days: number): LocalDate {
  return format(addDays(parseISO(date), days), "yyyy-MM-dd");
}

/** 0 = Sunday … 6 = Saturday */
export function weekdayOf(date: LocalDate): number {
  return getDay(parseISO(date));
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  return differenceInCalendarDays(parseISO(b), parseISO(a));
}

export function dateRange(from: LocalDate, toInclusive: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  for (let d = from; d <= toInclusive; d = addLocalDays(d, 1)) out.push(d);
  return out;
}

export function normalizeTime(t: string): string {
  const [h = "0", m = "0", s = "0"] = t.split(":");
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}:${s.padStart(2, "0")}`;
}

export function timeToMinutes(t: string): number {
  const [h, m] = normalizeTime(t).split(":").map(Number);
  return h * 60 + m;
}

export function minutesToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "Saturday 12 September" */
export function formatLongDate(instant: Date, tz: string): string {
  return formatInTimeZone(instant, tz, "EEEE d MMMM");
}

export function formatLongDateFromLocal(date: LocalDate): string {
  return format(parseISO(date), "EEEE d MMMM");
}

export function formatShortDateFromLocal(date: LocalDate): string {
  return format(parseISO(date), "EEE d MMM");
}

/** "1:30 pm" */
export function formatTime(instant: Date, tz: string): string {
  return formatInTimeZone(instant, tz, "h:mm aaa");
}

/** "Saturday 12 September at 1:30 pm" */
export function formatDateTime(instant: Date, tz: string): string {
  return `${formatLongDate(instant, tz)} at ${formatTime(instant, tz)}`;
}

export function addHours(instant: Date, hours: number): Date {
  return new Date(instant.getTime() + hours * 3_600_000);
}

export function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 3_600_000;
}
