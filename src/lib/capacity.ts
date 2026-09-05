import type { ProgramSettings } from "./settings";
import {
  addHours,
  addLocalDays,
  localToUtc,
  minutesToTime,
  timeToMinutes,
  toLocalDate,
  weekdayOf,
  type LocalDate,
} from "./time";

export type RuleLike = {
  weekday: number;
  capacity: number;
  windowStart: string;
  windowEnd: string;
  maxConcurrent: number;
};

export type OverrideLike = {
  onDate: LocalDate;
  capacity: number;
  windowStart: string | null;
  windowEnd: string | null;
  maxConcurrent: number | null;
  note?: string | null;
};

export type EffectiveDay = {
  date: LocalDate;
  capacity: number;
  windowStart: string;
  windowEnd: string;
  maxConcurrent: number;
  closed: boolean;
  overridden: boolean;
  note: string | null;
};

/** §6.1 — per-date override wins field by field over the weekday template. */
export function effectiveCapacity(
  date: LocalDate,
  rules: RuleLike[],
  overrides: OverrideLike[],
): EffectiveDay {
  const t = rules.find((r) => r.weekday === weekdayOf(date));
  const o = overrides.find((x) => x.onDate === date);
  const capacity = o?.capacity ?? t?.capacity ?? 0;
  const windowStart = o?.windowStart ?? t?.windowStart ?? "00:00";
  const windowEnd = o?.windowEnd ?? t?.windowEnd ?? "00:00";
  const maxConcurrent = o?.maxConcurrent ?? t?.maxConcurrent ?? 1;
  return {
    date,
    capacity,
    windowStart,
    windowEnd,
    maxConcurrent,
    closed: capacity === 0,
    overridden: !!o,
    note: o?.note ?? null,
  };
}

/** §6.4 — the last slot is the last start where start + slot_minutes ≤ window_end. */
export function slotStarts(day: EffectiveDay, slotMinutes: number): string[] {
  if (day.closed) return [];
  const out: string[] = [];
  const end = timeToMinutes(day.windowEnd);
  for (let m = timeToMinutes(day.windowStart); m + slotMinutes <= end; m += slotMinutes) {
    out.push(minutesToTime(m));
  }
  return out;
}

export function isOpenDay(date: LocalDate, rules: RuleLike[], overrides: OverrideLike[]): boolean {
  return !effectiveCapacity(date, rules, overrides).closed;
}

/** Build-by = the last open day strictly before the appointment date. */
export function buildByDate(
  appointmentDate: LocalDate,
  rules: RuleLike[],
  overrides: OverrideLike[],
): LocalDate {
  let d = addLocalDays(appointmentDate, -1);
  for (let i = 0; i < 30; i++) {
    if (isOpenDay(d, rules, overrides)) return d;
    d = addLocalDays(d, -1);
  }
  return addLocalDays(appointmentDate, -1);
}

export type Slot = {
  startsAt: Date;
  endsAt: Date;
  startLocal: string;
  available: boolean;
  reason: "day_full" | "time_full" | "too_early" | null;
  storageApplies: boolean;
  storageEstimateCents: number;
};

export type SlotContext = {
  tz: string;
  settings: ProgramSettings;
  now: Date;
  invitedAt: Date;
  pickupBy: Date;
  /** booked_count from day_counters for this date */
  bookedCount: number;
  /** starts_at of every booked appointment on this date */
  bookedStarts: Date[];
  /** projected storage for a pickup on `date`; 0 when storage does not apply */
  storageEstimate: (date: LocalDate) => number;
  /** Can the bike still be built in time for this slot? (build-schedule.ts; false → too_early) */
  buildFeasible?: (date: LocalDate, startsAt: Date) => boolean;
};

/** §6.2 slot generation for one day. Returns [] for closed days or days past the horizon. */
export function slotsForDay(
  date: LocalDate,
  day: EffectiveDay,
  ctx: SlotContext,
): Slot[] {
  if (day.closed) return [];
  const latestDate = addLocalDays(
    toLocalDate(ctx.invitedAt, ctx.tz),
    ctx.settings.booking_horizon_days,
  );
  if (date > latestDate) return [];

  const earliest = addHours(ctx.now, ctx.settings.min_lead_hours);
  const remainingDay = day.capacity - ctx.bookedCount;
  const storageApplies = date > toLocalDate(ctx.pickupBy, ctx.tz);
  const storageEstimateCents = storageApplies ? ctx.storageEstimate(date) : 0;

  return slotStarts(day, ctx.settings.slot_minutes).map((startLocal) => {
    const startsAt = localToUtc(date, startLocal, ctx.tz);
    const endsAt = new Date(startsAt.getTime() + ctx.settings.slot_minutes * 60_000);
    const atTime = ctx.bookedStarts.filter((s) => s.getTime() === startsAt.getTime()).length;
    let reason: Slot["reason"] = null;
    if (startsAt < earliest) reason = "too_early";
    else if (ctx.buildFeasible && !ctx.buildFeasible(date, startsAt)) reason = "too_early";
    else if (remainingDay <= 0) reason = "day_full";
    else if (atTime >= day.maxConcurrent) reason = "time_full";
    return {
      startsAt,
      endsAt,
      startLocal,
      available: reason === null,
      reason,
      storageApplies,
      storageEstimateCents,
    };
  });
}

export type DaySummary = {
  date: LocalDate;
  day: EffectiveDay;
  slots: Slot[];
  remaining: number;
  bookable: boolean;
  /** Why a day cannot be booked; null when bookable. */
  reason: "closed" | "full" | "too_soon" | "horizon" | null;
  storageApplies: boolean;
  storageEstimateCents: number;
  beyondHorizon: boolean;
};

export function summarizeDay(date: LocalDate, day: EffectiveDay, ctx: SlotContext): DaySummary {
  const slots = slotsForDay(date, day, ctx);
  const latestDate = addLocalDays(
    toLocalDate(ctx.invitedAt, ctx.tz),
    ctx.settings.booking_horizon_days,
  );
  const beyondHorizon = date > latestDate;
  const remaining = Math.max(0, day.capacity - ctx.bookedCount);
  const bookable = slots.some((s) => s.available);
  let reason: DaySummary["reason"] = null;
  if (!bookable) {
    if (day.closed) reason = "closed";
    else if (beyondHorizon) reason = "horizon";
    else if (remaining === 0) reason = "full";
    else if (slots.every((s) => s.reason === "too_early")) reason = "too_soon";
    else reason = "full";
  }
  return {
    date,
    day,
    slots,
    remaining,
    bookable,
    reason,
    storageApplies: slots[0]?.storageApplies ?? false,
    storageEstimateCents: slots[0]?.storageEstimateCents ?? 0,
    beyondHorizon,
  };
}
