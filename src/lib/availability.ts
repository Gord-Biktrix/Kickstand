import { and, between, eq } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { appointments, dayCounters, type Order, type Unit } from "@/db/schema";
import { effectiveCapacity, summarizeDay, type DaySummary, type SlotContext } from "./capacity";
import { getCapacityConfig, type ShowroomCtx } from "./showroom";
import { storageEstimateCents } from "./storage";
import { addLocalDays, dateRange, toLocalDate, type LocalDate } from "./time";

/**
 * §6.2 for a range of days: one query for counters, one for booked appointments.
 * Defaults to today → invite + horizon.
 */
export async function getAvailability(
  dbx: DbOrTx,
  args: {
    showroom: ShowroomCtx;
    unit: Unit;
    order: Order | null;
    now?: Date;
    from?: LocalDate;
    to?: LocalDate;
  },
): Promise<DaySummary[]> {
  const { showroom, unit, order } = args;
  const now = args.now ?? new Date();
  const tz = showroom.timezone;
  const settings = showroom.settings;
  if (!unit.invitedAt || !unit.pickupBy) return [];

  const from = args.from ?? toLocalDate(now, tz);
  const to =
    args.to ?? addLocalDays(toLocalDate(unit.invitedAt, tz), settings.booking_horizon_days);
  if (to < from) return [];

  const [{ rules, overrides }, counters, booked] = await Promise.all([
    getCapacityConfig(dbx, showroom.id, from),
    dbx
      .select()
      .from(dayCounters)
      .where(and(eq(dayCounters.showroomId, showroom.id), between(dayCounters.onDate, from, to))),
    dbx
      .select({ onDate: appointments.onDate, startsAt: appointments.startsAt })
      .from(appointments)
      .where(
        and(
          eq(appointments.showroomId, showroom.id),
          eq(appointments.status, "booked"),
          between(appointments.onDate, from, to),
        ),
      ),
  ]);

  const countByDate = new Map(counters.map((c) => [c.onDate, c.bookedCount]));
  const startsByDate = new Map<string, Date[]>();
  for (const b of booked) {
    const list = startsByDate.get(b.onDate) ?? [];
    list.push(b.startsAt);
    startsByDate.set(b.onDate, list);
  }
  const termsVersion = order?.termsVersion ?? 1;

  return dateRange(from, to).map((date) => {
    const day = effectiveCapacity(date, rules, overrides);
    const ctx: SlotContext = {
      tz,
      settings,
      now,
      invitedAt: unit.invitedAt!,
      pickupBy: unit.pickupBy!,
      bookedCount: countByDate.get(date) ?? 0,
      bookedStarts: startsByDate.get(date) ?? [],
      storageEstimate: (d) => storageEstimateCents(unit, termsVersion, settings, d, tz),
    };
    return summarizeDay(date, day, ctx);
  });
}
