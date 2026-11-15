const ZONE_LABEL: Record<string, string> = {
  "America/Vancouver": "Pacific time",
  "America/Edmonton": "Mountain time",
  "America/Regina": "Saskatchewan time",
  "America/Winnipeg": "Central time",
  "America/Toronto": "Eastern time",
  "America/Halifax": "Atlantic time",
  "America/St_Johns": "Newfoundland time",
  "America/Los_Angeles": "Pacific time (US)",
  "America/Denver": "Mountain time (US)",
  "America/Phoenix": "Arizona time",
  "America/Chicago": "Central time (US)",
  "America/New_York": "Eastern time (US)",
};

/** "Pacific time" for a profile's time zone, for the "times are shown in…" line. */
export function zoneLabel(tz: string): string {
  return ZONE_LABEL[tz] ?? tz.replace(/^.*\//, "").replace(/_/g, " ") + " time";
}

