/**
 * Saskatchewan's statutory (general) holidays for any year, worked out from their rules so nobody has to type
 * the dates in each January. Used by Settings › Availability › Closed days ("Add Saskatchewan holidays").
 * Boxing Day, Easter Monday and Truth and Reconciliation Day are not general holidays in Saskatchewan.
 */
import type { LocalDate } from "./time";

export type Holiday = { date: LocalDate; name: string };

const ymd = (y: number, m: number, d: number): LocalDate => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Day of week (0 = Sunday) for a calendar date. */
function dow(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The nth (1-based) given weekday of a month, e.g. the 3rd Monday of February. */
function nthWeekday(y: number, m: number, weekday: number, n: number): number {
  return 1 + ((weekday - dow(y, m, 1) + 7) % 7) + (n - 1) * 7;
}

/** The last given weekday on or before a day of the month (Victoria Day: the Monday before May 25). */
function weekdayOnOrBefore(y: number, m: number, d: number, weekday: number): number {
  return d - ((dow(y, m, d) - weekday + 7) % 7);
}

/** Western Easter Sunday (anonymous Gregorian algorithm). */
export function easterSunday(y: number): { month: number; day: number } {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return { month, day: ((h + l - 7 * m + 114) % 31) + 1 };
}

export function saskatchewanHolidays(year: number): Holiday[] {
  const easter = easterSunday(year);
  const goodFriday = new Date(Date.UTC(year, easter.month - 1, easter.day - 2));
  const MON = 1;
  return [
    { date: ymd(year, 1, 1), name: "New Year's Day" },
    { date: ymd(year, 2, nthWeekday(year, 2, MON, 3)), name: "Family Day" },
    { date: ymd(year, goodFriday.getUTCMonth() + 1, goodFriday.getUTCDate()), name: "Good Friday" },
    { date: ymd(year, 5, weekdayOnOrBefore(year, 5, 24, MON)), name: "Victoria Day" },
    { date: ymd(year, 7, 1), name: "Canada Day" },
    { date: ymd(year, 8, nthWeekday(year, 8, MON, 1)), name: "Saskatchewan Day" },
    { date: ymd(year, 9, nthWeekday(year, 9, MON, 1)), name: "Labour Day" },
    { date: ymd(year, 10, nthWeekday(year, 10, MON, 2)), name: "Thanksgiving" },
    { date: ymd(year, 11, 11), name: "Remembrance Day" },
    { date: ymd(year, 12, 25), name: "Christmas Day" },
  ];
}
