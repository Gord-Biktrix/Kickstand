/**
 * Showing booking times in the customer's own time zone. Slots are worked out in the store's zone
 * (type-slots.ts); for display they are regrouped by the customer's local date and labelled with their local
 * time. The zone comes from ?tz= (set by the page from the browser, or picked by the customer); anything that
 * isn't a real IANA zone falls back to the store's.
 */
import type { TypeDay, TypeSlot } from "./type-slots";
import { toLocalDate, type LocalDate } from "./time";

export function validTimeZone(tz: string | undefined | null): string | null {
  if (!tz || tz.length > 64 || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return null;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** The zone to show times in: the customer's choice when valid, else the store's. */
export function viewZone(param: string | undefined, storeTz: string): string {
  return validTimeZone(param) ?? storeTz;
}

function localHHMM(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("hour")}:${get("minute")}`;
}

/** Regroup the store's days by the viewer's local date, with each slot's `time` in the viewer's zone. */
export function daysInZone(days: TypeDay[], storeTz: string, viewTz: string): TypeDay[] {
  if (viewTz === storeTz) return days;
  const byDate = new Map<LocalDate, TypeSlot[]>();
  for (const d of days) {
    for (const s of d.slots) {
      const date = toLocalDate(s.startsAt, viewTz);
      const list = byDate.get(date) ?? [];
      list.push({ ...s, time: localHHMM(s.startsAt, viewTz) });
      byDate.set(date, list);
    }
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, slots]) => ({ date, slots: slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()) }));
}

