/**
 * Canadian zones go by their name, not PST/PDT: B.C. has stayed on UTC-7 year-round since March 2026 and calls
 * it simply "Pacific time" (Yukon did the same in 2020), so the old standard/daylight abbreviations mislead.
 */
export const CANADIAN_ZONE_NAMES: Record<string, string> = {
  "America/Vancouver": "Pacific time",
  "America/Whitehorse": "Yukon time",
  "America/Dawson": "Yukon time",
  "America/Edmonton": "Mountain time",
  "America/Yellowknife": "Mountain time",
  "America/Regina": "Saskatchewan time",
  "America/Swift_Current": "Saskatchewan time",
  "America/Winnipeg": "Central time",
  "America/Toronto": "Eastern time",
  "America/Halifax": "Atlantic time",
  "America/Moncton": "Atlantic time",
  "America/St_Johns": "Newfoundland time",
};

const ZONE_LABEL: Record<string, string> = {
  ...CANADIAN_ZONE_NAMES,
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

