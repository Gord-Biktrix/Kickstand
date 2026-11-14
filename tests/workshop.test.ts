import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import type { ShowroomCtx } from "@/lib/showroom";
import { localToUtc } from "@/lib/time";
import { buildJob, buildReadyBy, repairJob, sortJobs } from "@/lib/workshop";

const TZ = "America/Vancouver";
const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, capacity: weekday <= 1 ? 0 : 3, windowStart: "12:00", windowEnd: "17:15", maxConcurrent: 1 }));

function showroom(mode: "pickup" | "assembly" = "assembly", buildMinutes = 120): ShowroomCtx {
  return {
    id: "s", slug: "vancouver", name: "Biktrix Vancouver", kind: "showroom", googleCalendarId: null, bookingHours: {}, timezone: TZ, addressLine: "", phone: null,
    createdAt: new Date(), updatedAt: new Date(), rawSettings: {},
    settings: { ...DEFAULT_SETTINGS, build_minutes: buildMinutes, lightspeed: { ...DEFAULT_SETTINGS.lightspeed, due_mode: mode, assembly_due_time_local: "10:00" } },
  };
}
const at = (date: string, time: string) => localToUtc(date, time, TZ);
const unit = (status: string, id = "u1") => ({ id, status, model: "Juggernaut Ultra", boxTag: "18", lsWorkorderId: null });

describe("workshop jobs", () => {
  it("assembly mode: start by = ready by − build time", () => {
    const sr = showroom("assembly", 120);
    const appt = { onDate: "2026-09-05", startsAt: at("2026-09-05", "14:00") };
    const readyBy = buildReadyBy(sr, appt, rules, []);
    expect(readyBy.toISOString()).toBe(at("2026-09-05", "10:00").toISOString());
    const job = buildJob(sr, { appointment: appt, unit: unit("booked"), order: { customerName: "Chris Wong" } }, readyBy, at("2026-09-05", "07:00"));
    expect(job.column).toBe("todo");
    expect(job.startBy.toISOString()).toBe(at("2026-09-05", "08:00").toISOString());
    expect(job.late).toBe(false);
  });

  it("pickup mode: ready by the close of the build day's window", () => {
    // Tuesday pickup → Saturday build day (Sun/Mon closed), window ends 17:15
    const readyBy = buildReadyBy(showroom("pickup"), { onDate: "2026-09-08", startsAt: at("2026-09-08", "13:00") }, rules, []);
    expect(readyBy.toISOString()).toBe(at("2026-09-05", "17:15").toISOString());
  });

  it("a build not started by its start time is late; one in progress is late after ready by", () => {
    const sr = showroom();
    const appt = { onDate: "2026-09-05", startsAt: at("2026-09-05", "14:00") };
    const readyBy = at("2026-09-05", "10:00");
    const now = at("2026-09-05", "08:30");
    expect(buildJob(sr, { appointment: appt, unit: unit("booked"), order: null }, readyBy, now).late).toBe(true);
    const doing = buildJob(sr, { appointment: appt, unit: unit("building"), order: null }, readyBy, now);
    expect(doing.column).toBe("doing");
    expect(doing.late).toBe(false);
    expect(buildJob(sr, { appointment: appt, unit: unit("building"), order: null }, readyBy, at("2026-09-05", "10:30")).late).toBe(true);
    expect(buildJob(sr, { appointment: appt, unit: unit("ready"), order: null }, readyBy, at("2026-09-05", "11:00"))).toMatchObject({ column: "ready", late: false });
  });

  it("repairs run during the appointment", () => {
    const booking = { id: "b1", startsAt: at("2026-09-05", "15:00"), endsAt: at("2026-09-05", "16:00"), customerName: "Ahmed Ali", lsWorkorderId: "10255" };
    const type = { name: "Tune-up", durationMin: 60 };
    expect(repairJob({ booking, type }, at("2026-09-05", "12:00"))).toMatchObject({ column: "todo", minutes: 60, late: false });
    expect(repairJob({ booking, type }, at("2026-09-05", "15:30"))).toMatchObject({ column: "doing", late: false });
    expect(repairJob({ booking, type }, at("2026-09-05", "16:30")).late).toBe(true);
  });

  it("sorts by start time", () => {
    const sr = showroom();
    const now = at("2026-09-01", "07:00");
    const appt = { onDate: "2026-09-05", startsAt: at("2026-09-05", "14:00") };
    const late = buildJob(sr, { appointment: appt, unit: unit("booked", "a"), order: null }, at("2026-09-05", "12:00"), now);
    const early = buildJob(sr, { appointment: appt, unit: unit("booked", "b"), order: null }, at("2026-09-04", "12:00"), now);
    expect(sortJobs([late, early]).map((j) => j.unitId)).toEqual(["b", "a"]);
  });
});
