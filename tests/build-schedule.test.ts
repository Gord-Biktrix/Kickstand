import { describe, expect, it } from "vitest";
import { buildDeadline } from "@/lib/build-schedule";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import type { ShowroomCtx } from "@/lib/showroom";
import { localToUtc } from "@/lib/time";

const TZ = "America/Vancouver";
// Closed Sunday (0) and Monday (1), open Tue–Sat — the Vancouver template.
const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, capacity: weekday <= 1 ? 0 : 3, windowStart: "12:00", windowEnd: "17:15", maxConcurrent: 1 }));

function showroom(mode: "pickup" | "assembly", time = "10:00"): ShowroomCtx {
  return {
    id: "s", slug: "vancouver", name: "Biktrix Vancouver", timezone: TZ, addressLine: "", phone: null,
    createdAt: new Date(), updatedAt: new Date(), rawSettings: {},
    settings: { ...DEFAULT_SETTINGS, lightspeed: { ...DEFAULT_SETTINGS.lightspeed, due_mode: mode, assembly_due_time_local: time } },
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
});
