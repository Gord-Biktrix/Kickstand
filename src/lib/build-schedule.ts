import type { Appointment } from "@/db/schema";
import { formatInTimeZone } from "date-fns-tz";
import { buildByDate, effectiveCapacity, type OverrideLike, type RuleLike } from "./capacity";
import type { ShowroomCtx } from "./showroom";
import { localToUtc, minutesToTime, timeToMinutes, type LocalDate } from "./time";

/**
 * The assembly deadline for a booked pickup — one rule shared by the Build board, the Schedule
 * tab and the Lightspeed work order's Due, so mechanics see the same answer everywhere.
 *
 * - `pickup` mode (spec default): build by the end of the last open day before the pickup.
 *   `at` is null; only the date is meaningful.
 * - `assembly` mode: build by `assembly_due_time_local` on the pickup day when the slot is later
 *   than that, otherwise on the previous open day. `at` is the exact instant.
 *
 * The mode lives under `settings.lightspeed` because it was introduced for the work-order Due,
 * but it is a workshop rule, not an integration detail.
 */
export type BuildDeadline = { date: LocalDate; at: Date | null };

/** A shop day is counted as this many working hours in "lead" mode, whatever the opening window. */
const WORK_DAY_HOURS = 8;

export function buildDeadline(
  showroom: ShowroomCtx,
  appt: Pick<Appointment, "onDate" | "startsAt">,
  rules: RuleLike[],
  overrides: OverrideLike[],
): BuildDeadline {
  const ls = showroom.settings.lightspeed;
  const prevOpen = buildByDate(appt.onDate, rules, overrides);
  if (ls.due_mode === "lead") return leadDeadline(showroom, appt, rules, overrides, ls.assembly_lead_work_hours);
  if (ls.due_mode !== "assembly") return { date: prevOpen, at: null };
  const sameDay = localToUtc(appt.onDate, ls.assembly_due_time_local, showroom.timezone);
  if (sameDay < appt.startsAt) return { date: appt.onDate, at: sameDay };
  return { date: prevOpen, at: localToUtc(prevOpen, ls.assembly_due_time_local, showroom.timezone) };
}

/**
 * "lead" mode — the build must be done N working hours before the pickup, counting only open days
 * and treating each as an 8-hour shop day. 8 hours therefore means the same clock time on the
 * previous open day (Friday 12:00 pickup → Thursday 12:00 build-by; Tuesday 12:00 → Saturday 12:00
 * when Sunday and Monday are closed). Left-over hours (N not a multiple of 8) are subtracted within
 * the day; if that lands before the day's opening time, the remainder rolls to the end of the
 * previous open day.
 */
function leadDeadline(
  showroom: ShowroomCtx,
  appt: Pick<Appointment, "onDate" | "startsAt">,
  rules: RuleLike[],
  overrides: OverrideLike[],
  leadHours: number,
): BuildDeadline {
  const tz = showroom.timezone;
  let date: LocalDate = appt.onDate;
  let minutes = timeToMinutes(formatInTimeZone(appt.startsAt, tz, "HH:mm"));
  let left = Math.max(1, leadHours) * 60;
  const wholeDays = Math.floor(left / (WORK_DAY_HOURS * 60));
  for (let i = 0; i < wholeDays; i++) date = buildByDate(date, rules, overrides);
  left -= wholeDays * WORK_DAY_HOURS * 60;
  if (left > 0) {
    const day = effectiveCapacity(date, rules, overrides);
    const open = timeToMinutes(day.windowStart);
    if (minutes - left >= open) {
      minutes -= left;
    } else {
      const overflow = left - (minutes - open);
      date = buildByDate(date, rules, overrides);
      minutes = timeToMinutes(effectiveCapacity(date, rules, overrides).windowEnd) - overflow;
    }
  }
  return { date, at: localToUtc(date, minutesToTime(Math.max(0, minutes)), tz) };
}
