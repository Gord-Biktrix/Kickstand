/**
 * Zones whose rules changed after the time-zone data our runtimes ship with (Node 24's ICU has tz 2025b).
 * B.C., Alberta (with Inuvik) and Manitoba stopped changing their clocks in 2026: they stayed on their summer
 * offset from 8 March 2026 (tz 2026f). Older tz data still falls back on 1 November, an hour out. From the
 * moment each zone sprang forward in March 2026 its offset is fixed, so we use the matching fixed zone
 * (Etc/GMT+7 is UTC−7: the Etc sign is inverted). Before that, the zone's own (correct) history applies.
 * With up-to-date tz data this gives the same answers, so it can stay until every runtime has caught up.
 * Shared by the server (lib/time.ts) and the browser (pickers), so both agree.
 */
const FIXED: Record<string, { from: number; zone: string }> = {};
function fix(zones: string[], fromIso: string, zone: string) {
  for (const z of zones) FIXED[z] = { from: Date.parse(fromIso), zone };
}
fix(["America/Vancouver", "Canada/Pacific"], "2026-03-08T10:00:00Z", "Etc/GMT+7");
fix(["America/Edmonton", "America/Yellowknife", "America/Inuvik", "Canada/Mountain"], "2026-03-08T09:00:00Z", "Etc/GMT+6");
fix(["America/Winnipeg", "Canada/Central"], "2026-03-08T08:00:00Z", "Etc/GMT+5");

/** The zone name to hand Intl / date-fns-tz for formatting `at` in `tz`. */
export function zoneAt(tz: string, at: Date | number): string {
  const f = FIXED[tz];
  return f && +at >= f.from ? f.zone : tz;
}

/** Same, for turning a local wall-clock "YYYY-MM-DD…" in `tz` into an instant. */
export function zoneForLocal(tz: string, local: string): string {
  const f = FIXED[tz];
  if (!f) return tz;
  // Any local date from 9 March 2026 on is past the change in every zone above.
  return local.slice(0, 10) >= "2026-03-09" ? f.zone : tz;
}
