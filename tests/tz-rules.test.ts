import { describe, expect, it } from "vitest";
import { formatTime, localToUtc, toLocalDate } from "@/lib/time";
import { zoneAt } from "@/lib/tz-rules";

// B.C., Alberta and Manitoba kept their summer clocks from March 2026 (tz 2026f). These hold whatever tz data
// the runtime ships.
describe("2026 Canadian clock changes", () => {
  it("Vancouver stays on UTC-7 after 1 November 2026", () => {
    expect(localToUtc("2026-11-17", "12:00", "America/Vancouver").toISOString()).toBe("2026-11-17T19:00:00.000Z");
    expect(formatTime(new Date("2026-11-17T20:00:00Z"), "America/Vancouver")).toBe("1:00 pm");
    expect(localToUtc("2027-01-10", "09:00", "America/Vancouver").toISOString()).toBe("2027-01-10T16:00:00.000Z");
  });
  it("summer 2026 and winter before the change are unchanged", () => {
    expect(localToUtc("2026-07-01", "12:00", "America/Vancouver").toISOString()).toBe("2026-07-01T19:00:00.000Z");
    expect(localToUtc("2026-01-15", "12:00", "America/Vancouver").toISOString()).toBe("2026-01-15T20:00:00.000Z");
    expect(zoneAt("America/Vancouver", new Date("2026-03-08T09:59:59Z"))).toBe("America/Vancouver");
  });
  it("Edmonton is UTC-6 and Winnipeg UTC-5 after the change; Toronto still falls back", () => {
    expect(localToUtc("2026-12-01", "10:00", "America/Edmonton").toISOString()).toBe("2026-12-01T16:00:00.000Z");
    expect(localToUtc("2026-12-01", "10:00", "America/Winnipeg").toISOString()).toBe("2026-12-01T15:00:00.000Z");
    expect(localToUtc("2026-12-01", "10:00", "America/Toronto").toISOString()).toBe("2026-12-01T15:00:00.000Z");
  });
  it("late evening stays on the right local day", () => {
    expect(toLocalDate(new Date("2026-12-02T06:30:00Z"), "America/Vancouver")).toBe("2026-12-01");
    expect(toLocalDate(new Date("2026-12-02T07:30:00Z"), "America/Vancouver")).toBe("2026-12-02");
  });
});
