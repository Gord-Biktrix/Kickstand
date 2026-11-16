import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import type { ShowroomCtx } from "@/lib/showroom";
import { localToUtc } from "@/lib/time";
import { buildJob, buildReadyBy, repairJob, sortJobs, withWorkorder, workorderJob } from "@/lib/workshop";
import { columnOf, defaultWorkshopColumns } from "@/lib/workshop-columns";

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

describe("Lightspeed work orders on the board", () => {
  // Vancouver's status list, 2026-11-16 (id, name, systemValue).
  const VAN: [number, string, string | null][] = [
    [27, "Appointment", null], [7, "Parts On Order", null], [30, "Diagnosis", null], [15, "Parts on hold", null], [31, "Waiting For Response", null],
    [1, "Open", "open"], [22, "Needs Testing", null], [28, "In Progress", null], [32, "QC Check", null], [4, "Finished", "finished"], [23, "Build", null],
    [17, "Floor Bike Repair", null], [16, "URGENT", null], [29, "Build To Be Scheduled", null], [25, "Build for FLOOR", null], [6, "Warranty", null],
    [14, "Parts arrived - next in the queue", null], [12, "Needs a test ride", null], [13, "CA# Not ready", null], [8, "CA# Ready for Pick up", null],
    [24, "Ready to ship", null], [18, "Floor Bike Repair - Waiting on parts", null], [19, "Floor Bike Repair - High Priority ", null], [2, "Estimate", "estimate"],
    [9, "Customer contacted", null], [5, "Done & Paid", "paid"], [3, "Waiting", "waiting"], [11, "Shop Inventory", null],
  ];
  const statuses = VAN.map(([id, name, systemValue]) => ({ id, name, systemValue }));

  it("suggests columns from Vancouver's status names", () => {
    const c = defaultWorkshopColumns(statuses);
    const names = (ids: number[]) => ids.map((id) => VAN.find((v) => v[0] === id)![1]).sort();
    expect(names(c.todo)).toEqual(["Appointment", "Build", "Build To Be Scheduled", "Build for FLOOR", "Diagnosis", "Floor Bike Repair", "Floor Bike Repair - High Priority ", "Open", "Parts arrived - next in the queue", "URGENT"].sort());
    expect(names(c.doing)).toEqual(["In Progress", "Needs Testing", "Needs a test ride", "QC Check"].sort());
    expect(names(c.parts)).toEqual(["Floor Bike Repair - Waiting on parts", "Parts On Order", "Parts on hold", "Waiting For Response", "Warranty"].sort());
    expect(names(c.ready)).toEqual(["CA# Ready for Pick up", "Finished", "Ready to ship"].sort());
    for (const off of [2, 5, 3, 11, 13]) expect(columnOf(c, off)).toBeNull();
  });

  const wo = (over: Partial<Parameters<typeof workorderJob>[0]> = {}) => ({ id: "10249", statusId: 1, customerName: "Tom Becker", item: "Juggernaut Classic · Black", note: "Brake bleed, rear pads\nCall when done", employeeId: "7", etaOut: at("2026-09-05", "13:30"), timeIn: at("2026-09-05", "09:30"), ...over });

  it("a work order starts the repair time before it's due, and shows the mechanic and the first note line", () => {
    const j = workorderJob(wo(), { column: "todo", status: "Open", mechanic: "Jordan Lee", repairMinutes: 60 }, at("2026-09-05", "11:00"));
    expect(j).toMatchObject({ kind: "repair", column: "todo", title: "Juggernaut Classic · Black", note: "Brake bleed, rear pads", mechanic: "Jordan Lee", source: "lightspeed", late: false });
    expect(j.startBy.toISOString()).toBe(at("2026-09-05", "12:30").toISOString());
    expect(j.href).toContain("10249");
    expect(workorderJob(wo(), { column: "todo", status: "Open", mechanic: null, repairMinutes: 60 }, at("2026-09-05", "12:45")).late).toBe(true);
    expect(workorderJob(wo(), { column: "parts", status: "Parts On Order", mechanic: null, repairMinutes: 60 }, at("2026-09-06", "12:00")).late).toBe(false);
  });

  it("no due date sorts last and is never late; shop bikes and builds are told apart", () => {
    const undated = workorderJob(wo({ etaOut: null }), { column: "todo", status: "Open", mechanic: null, repairMinutes: 60 }, at("2026-09-05", "11:00"));
    expect(undated).toMatchObject({ noDate: true, late: false });
    const dated = workorderJob(wo({ id: "2" }), { column: "todo", status: "Open", mechanic: null, repairMinutes: 60 }, at("2026-09-05", "11:00"));
    expect(sortJobs([undated, dated]).map((j) => j.workorderId)).toEqual(["2", "10249"]);
    expect(workorderJob(wo({ customerName: "" }), { column: "todo", status: "Floor Bike Repair", mechanic: null, repairMinutes: 60 }, at("2026-09-05", "11:00")).kind).toBe("floor");
    expect(workorderJob(wo(), { column: "todo", status: "Build", mechanic: null, repairMinutes: 60 }, at("2026-09-05", "11:00")).kind).toBe("build");
    expect(workorderJob(wo({ item: "", note: "" }), { column: "todo", status: "Open", mechanic: null, repairMinutes: 60 }, at("2026-09-05", "11:00")).title).toBe("Work order #10249");
  });

  it("a booked repair follows its work order's column; a bike keeps Kickstand's build status", () => {
    const columns = defaultWorkshopColumns(statuses);
    const ctx = { columns, statusName: (id: number) => VAN.find((v) => v[0] === id)![1], mechanicName: (id: string | null) => (id === "7" ? "Jordan Lee" : null) };
    const booking = { id: "b1", startsAt: at("2026-09-05", "15:00"), endsAt: at("2026-09-05", "16:00"), customerName: "Ahmed Ali", lsWorkorderId: "10249" };
    const repair = repairJob({ booking, type: { name: "Tune-up", durationMin: 60 } }, at("2026-09-05", "12:00"));
    expect(withWorkorder(repair, wo({ statusId: 7 }), ctx, at("2026-09-05", "12:00"))).toMatchObject({ column: "parts", status: "Parts On Order", mechanic: "Jordan Lee" });
    expect(withWorkorder(repair, undefined, ctx, at("2026-09-05", "12:00")).column).toBe("todo");
    const sr = showroom();
    const build = buildJob(sr, { appointment: { onDate: "2026-09-05", startsAt: at("2026-09-05", "14:00") }, unit: unit("building"), order: null }, at("2026-09-05", "10:00"), at("2026-09-05", "09:00"));
    expect(withWorkorder(build, wo({ statusId: 4 }), ctx, at("2026-09-05", "09:00"))).toMatchObject({ column: "doing", mechanic: "Jordan Lee", status: "Finished" });
  });
});
