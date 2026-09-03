import type { Appointment } from "@/db/schema";
import { buildByDate, type OverrideLike, type RuleLike } from "./capacity";
import type { ShowroomCtx } from "./showroom";
import { localToUtc, type LocalDate } from "./time";

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

export function buildDeadline(
  showroom: ShowroomCtx,
  appt: Pick<Appointment, "onDate" | "startsAt">,
  rules: RuleLike[],
  overrides: OverrideLike[],
): BuildDeadline {
  const ls = showroom.settings.lightspeed;
  const prevOpen = buildByDate(appt.onDate, rules, overrides);
  if (ls.due_mode !== "assembly") return { date: prevOpen, at: null };
  const sameDay = localToUtc(appt.onDate, ls.assembly_due_time_local, showroom.timezone);
  if (sameDay < appt.startsAt) return { date: appt.onDate, at: sameDay };
  return { date: prevOpen, at: localToUtc(prevOpen, ls.assembly_due_time_local, showroom.timezone) };
}
