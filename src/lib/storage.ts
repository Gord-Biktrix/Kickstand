import type { ProgramSettings } from "./settings";
import { addLocalDays, daysBetween, toLocalDate, type LocalDate } from "./time";

type StorageUnit = { storageFrom: Date | null; pickupBy: Date | null };

export function storageEnabledFor(settings: ProgramSettings, termsVersion: number): boolean {
  return settings.storage_fee_enabled && termsVersion >= 2;
}

/** First chargeable local day: storage_from if set, else the day after pick-up-by. */
export function storageStartDate(unit: StorageUnit, tz: string): LocalDate | null {
  if (unit.storageFrom) return toLocalDate(unit.storageFrom, tz);
  if (unit.pickupBy) return addLocalDays(toLocalDate(unit.pickupBy, tz), 1);
  return null;
}

function accrued(
  start: LocalDate | null,
  onDate: LocalDate,
  settings: ProgramSettings,
): number {
  if (!start || onDate < start) return 0;
  const days = daysBetween(start, onDate) + 1; // the start day counts as day 1
  return Math.min(settings.storage_cap_cents, settings.storage_rate_cents * days);
}

/** Projected storage for a pickup on `onDate` (used on the slot picker). */
export function storageEstimateCents(
  unit: StorageUnit,
  termsVersion: number,
  settings: ProgramSettings,
  onDate: LocalDate,
  tz: string,
): number {
  if (!storageEnabledFor(settings, termsVersion)) return 0;
  return accrued(storageStartDate(unit, tz), onDate, settings);
}

/** §5 derived storage_due_cents: 0 until storage_from is actually set. */
export function storageDueCents(
  unit: StorageUnit,
  termsVersion: number,
  settings: ProgramSettings,
  at: Date,
  tz: string,
): number {
  if (!unit.storageFrom || !storageEnabledFor(settings, termsVersion)) return 0;
  return accrued(toLocalDate(unit.storageFrom, tz), toLocalDate(at, tz), settings);
}
