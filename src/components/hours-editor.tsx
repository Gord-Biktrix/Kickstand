import type { WeeklyHours } from "@/lib/booking-types";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// Monday first, as people read a week.
const ORDER = [1, 2, 3, 4, 5, 6, 0];

/**
 * Weekly hours as Calendly shows them: a row per day with an "open" tick, a start and end time, and an optional
 * second range (for a lunch break). Field names: `<prefix>day_<wd>` (on), `<prefix>s1_<wd>`, `<prefix>e1_<wd>`,
 * `<prefix>s2_<wd>`, `<prefix>e2_<wd>`; read back with hoursFromForm in booking-types.ts.
 */
export function HoursEditor({ hours, prefix = "" }: { hours: WeeklyHours; prefix?: string }) {
  return (
    <div className="divide-y divide-border rounded-lg border border-border">
      {ORDER.map((wd) => {
        const ranges = hours[String(wd)] ?? [];
        const [r1, r2] = ranges;
        return (
          <div key={wd} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
            <label className="flex w-32 items-center gap-2 text-sm font-medium">
              <input type="checkbox" name={`${prefix}day_${wd}`} defaultChecked={ranges.length > 0} className="h-4 w-4" />
              {DAYS[wd]}
            </label>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <input type="time" name={`${prefix}s1_${wd}`} defaultValue={r1?.[0] ?? "09:00"} aria-label={`${DAYS[wd]} start`} className="input h-9 w-32 py-0" />
              <span className="text-muted">–</span>
              <input type="time" name={`${prefix}e1_${wd}`} defaultValue={r1?.[1] ?? "17:00"} aria-label={`${DAYS[wd]} end`} className="input h-9 w-32 py-0" />
              <span className="ml-2 text-xs text-muted">and</span>
              <input type="time" name={`${prefix}s2_${wd}`} defaultValue={r2?.[0] ?? ""} aria-label={`${DAYS[wd]} second start (optional)`} className="input h-9 w-32 py-0" />
              <span className="text-muted">–</span>
              <input type="time" name={`${prefix}e2_${wd}`} defaultValue={r2?.[1] ?? ""} aria-label={`${DAYS[wd]} second end (optional)`} className="input h-9 w-32 py-0" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
