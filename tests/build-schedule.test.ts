import { describe, expect, it } from "vitest";
import { buildDeadline, buildFeasibleAt } from "@/lib/build-schedule";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import type { ShowroomCtx } from "@/lib/showroom";
import { localToUtc } from "@/lib/time";

const TZ = "America/Vancouver";
// Closed Sunday (0) and Monday (1), open Tue–Sat — the Vancouver template.
const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, capacity: weekday <= 1 ? 0 : 3, windowStart: "12:00", windowEnd: "17:15", maxConcurrent: 1 }));

function showroom(mode: "pickup" | "assembly" | "lead", time = "10:00", leadHours = 8): ShowroomCtx {
  return {
    id: "s", slug: "vancouver", name: "Biktrix Vancouver", timezone: TZ, addressLine: "", phone: null,
    createdAt: new Date(), updatedAt: new Date(), rawSettings: {},
    settings: { ...DEFAULT_SETTINGS, lightspeed: { ...DEFAULT_SETTINGS.lightspeed, due_mode: mode, assembly_due_time_local: time, assembly_lead_work_hours: leadHours } },
  };
}
const appt = (date: string, time: string) => ({ onDate: date, startsAt: localToUtc(date, time, TZ) });

describe("buildDeadline", () => {
  it("pickup mode: last open day before the pickup, no time", () => {
    // Tuesday pickup → previous open day is Saturday (Sun/Mon closed)
    expect(buildDeadline(showroom("pickup"), appt("2026-09-08", "13:15"), rules, [])).toEqual({ date: "2026-09-05", at: null });
    expect(buildDeadline(showroom("pickup"), appt("2026-09-05", "14:45"), rules, [])).toEqual({ date: "2026-09-04", at: null });
  });

  it("assembly mode: 10:00 on the pickup day when the slot is later", () => {
    const d = buildDeadline(showroom("assembly"), appt("2026-09-05", "14:45"), rules, []);
    expect(d.date).toBe("2026-09-05");
    expect(d.at?.toISOString()).toBe(localToUtc("2026-09-05", "10:00", TZ).toISOString());
  });

  it("assembly mode: falls back to the previous open day when the slot is before the due time", () => {
    // 16:00 due time, 12:00 Tuesday slot → Saturday 16:00 (Sun/Mon closed)
    const d = buildDeadline(showroom("assembly", "16:00"), appt("2026-09-08", "12:00"), rules, []);
    expect(d.date).toBe("2026-09-05");
    expect(d.at?.toISOString()).toBe(localToUtc("2026-09-05", "16:00", TZ).toISOString());
  });

  it("assembly mode honours a closure override", () => {
    // Friday closed by override → Saturday 12:00 pickup with 14:00 due time → Thursday 14:00
    const overrides = [{ onDate: "2026-09-04", capacity: 0, windowStart: null, windowEnd: null, maxConcurrent: null }];
    const d = buildDeadline(showroom("assembly", "14:00"), appt("2026-09-05", "12:00"), rules, overrides);
    expect(d.date).toBe("2026-09-03");
  });

  it("lead mode: 8 working hours = same time on the previous open day", () => {
    // Friday 12:00 → Thursday 12:00
    expect(buildDeadline(showroom("lead"), appt("2026-09-04", "12:00"), rules, [])).toEqual({ date: "2026-09-03", at: localToUtc("2026-09-03", "12:00", TZ) });
    // Tuesday 12:00 → Saturday 12:00 (Sunday and Monday closed)
    expect(buildDeadline(showroom("lead"), appt("2026-09-08", "12:00"), rules, [])).toEqual({ date: "2026-09-05", at: localToUtc("2026-09-05", "12:00", TZ) });
  });

  it("lead mode: partial hours stay in the day, or roll to the end of the previous open day", () => {
    // 4 hours before a 16:00 Friday pickup → Friday 12:00 (window opens 12:00)
    expect(buildDeadline(showroom("lead", "10:00", 4), appt("2026-09-04", "16:00"), rules, [])).toEqual({ date: "2026-09-04", at: localToUtc("2026-09-04", "12:00", TZ) });
    // 4 hours before a 13:00 Friday pickup: only 1h available Friday → 3h before Thursday's 17:15 close = 14:15
    expect(buildDeadline(showroom("lead", "10:00", 4), appt("2026-09-04", "13:00"), rules, [])).toEqual({ date: "2026-09-03", at: localToUtc("2026-09-03", "14:15", TZ) });
    // 16 hours = two shop days back
    expect(buildDeadline(showroom("lead", "10:00", 16), appt("2026-09-04", "12:00"), rules, [])).toEqual({ date: "2026-09-02", at: localToUtc("2026-09-02", "12:00", TZ) });
  });

  it("lead mode: a slot is only feasible while its build deadline is still ahead", () => {
    // Saturday 5 Sep 16:37: Tuesday 10:00 needs a Saturday 10:00 build → gone; Wednesday 10:00 → Tuesday 10:00 → fine.
    const now = localToUtc("2026-09-05", "16:37", TZ);
    expect(buildFeasibleAt(showroom("lead"), appt("2026-09-08", "10:00"), rules, [], now)).toBe(false);
    expect(buildFeasibleAt(showroom("lead"), appt("2026-09-08", "16:00"), rules, [], now)).toBe(false);
    expect(buildFeasibleAt(showroom("lead"), appt("2026-09-09", "10:00"), rules, [], now)).toBe(true);
    // pickup mode: end of the previous open day
    expect(buildFeasibleAt(showroom("pickup"), appt("2026-09-08", "12:00"), rules, [], now)).toBe(true); // Saturday still has hours left
    expect(buildFeasibleAt(showroom("pickup"), appt("2026-09-08", "12:00"), rules, [], localToUtc("2026-09-06", "09:00", TZ))).toBe(false);
  });
});

