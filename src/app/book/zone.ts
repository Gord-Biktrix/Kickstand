const ZONE_LABEL: Record<string, string> = {
  "America/Vancouver": "Pacific time",
  "America/Edmonton": "Mountain time",
  "America/Regina": "Saskatchewan time",
  "America/Winnipeg": "Central time",
  "America/Toronto": "Eastern time",
  "America/Halifax": "Atlantic time",
};

/** "Pacific time" for a profile's time zone, for the "times are shown in…" line. */
export function zoneLabel(tz: string): string {
  return ZONE_LABEL[tz] ?? tz.replace(/^.*\//, "").replace(/_/g, " ") + " time";
}
