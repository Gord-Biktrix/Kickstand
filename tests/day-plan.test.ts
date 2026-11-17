import { describe, expect, it } from "vitest";
import { pct, planDay, type PlanJob, type PlanTrack } from "@/lib/day-plan";

const D = (hhmm: string) => new Date(`2027-11-16T${hhmm}:00Z`);
const job = (over: Partial<PlanJob> & { id: string }): PlanJob => ({
  kind: "repair", column: "todo", title: over.id, customer: null, minutes: 60, startBy: D("09:00"), readyBy: D("18:00"), visitAt: D("09:00"),
  noDate: false, notHereYet: false, mechanicId: null, mechanic: null, assignable: true, ...over,
});
const track = (over: Partial<PlanTrack>): PlanTrack => ({ running: false, handsOn: 0, startedAt: null, readyAt: null, pausedAt: null, label: null, ...over });

describe("the Workshop day plan", () => {
  const start = D("09:00");
  const end = D("18:00");
  const now = D("14:00");

  it("lays out done, running, waiting and still-to-do work in each mechanic's lane", () => {
    const jobs = [
      job({ id: "done", column: "ready", mechanicId: "1", mechanic: "Jordan" }),
      job({ id: "run", column: "doing", mechanicId: "1", mechanic: "Jordan", minutes: 90 }),
      job({ id: "next", mechanicId: "1", mechanic: "Jordan", startBy: D("10:00"), minutes: 60 }),
      job({ id: "parts", column: "parts", mechanicId: "2", mechanic: "Sam" }),
      job({ id: "free", startBy: D("15:00"), minutes: 30 }),
    ];
    const tracks = new Map([
      ["done", track({ startedAt: D("09:10"), readyAt: D("10:00"), handsOn: 50 })],
      ["run", track({ running: true, handsOn: 60, label: "Repair 1 of 3" })],
      ["parts", track({ pausedAt: D("11:00"), handsOn: 40 })],
    ]);
    const plan = planDay({ jobs, tracks, start, end, now });
    expect(plan.lanes.map((l) => l.name)).toEqual(["Jordan", "Sam", "Unassigned"]);
    const jordan = plan.lanes[0].blocks.map((b) => [b.jobId, b.state, b.start.toISOString().slice(11, 16), b.end.toISOString().slice(11, 16)]);
    expect(jordan).toEqual([
      ["done", "done", "09:10", "10:00"],
      ["run", "running", "13:00", "14:30"],
      ["next", "planned", "14:30", "15:30"],
    ]);
    expect(plan.lanes[1].blocks[0]).toMatchObject({ state: "waiting", start: D("10:20"), end: D("11:00") });
    // A bike that's here is planned from now, not from its latest start.
    expect(plan.lanes[2].blocks[0]).toMatchObject({ jobId: "free", start: D("14:00"), end: D("14:30") });
    expect(plan.lanes[0].minutes).toBe(90); // 30 min left on the running job + the next hour
    expect(plan).toMatchObject({ waiting: 1, unassigned: 1, late: 0, overflow: 0 });
  });

  it("flags work that will miss its ready-by, waits for a drop-off, and counts what doesn't fit", () => {
    const jobs = [
      job({ id: "late", mechanicId: "3", mechanic: "Priya", startBy: D("13:00"), readyBy: D("15:00"), minutes: 120 }),
      job({ id: "dropoff", notHereYet: true, visitAt: D("16:00"), startBy: D("10:00") }),
      job({ id: "tomorrow", notHereYet: true, visitAt: D("19:00") }),
    ];
    const plan = planDay({ jobs, tracks: new Map(), start, end, now });
    expect(plan.lanes[0].blocks[0]).toMatchObject({ jobId: "late", late: true, start: D("14:00"), end: D("16:00") });
    expect(plan.lanes[1].blocks[0]).toMatchObject({ jobId: "dropoff", start: D("16:00") });
    expect(plan).toMatchObject({ late: 1, overflow: 1 });
    expect(pct(D("13:30"), plan)).toBe(50);
  });

  it("puts customer work before floor bikes and only counts parts jobs that stopped before today", () => {
    const jobs = [
      job({ id: "floor", kind: "floor", mechanicId: "1", mechanic: "Carter", startBy: D("08:00"), readyBy: D("08:00") }),
      job({ id: "walkin", mechanicId: "1", mechanic: "Carter", startBy: D("16:00") }),
      job({ id: "old-parts", column: "parts", mechanicId: "2", mechanic: "Gray" }),
    ];
    const plan = planDay({ jobs, tracks: new Map(), start, end, now });
    expect(plan.lanes[0].blocks.map((b) => [b.jobId, b.start.toISOString().slice(11, 16), b.late])).toEqual([
      ["walkin", "14:00", false],
      ["floor", "15:00", true],
    ]);
    expect(plan.lanes[1]).toMatchObject({ name: "Gray", blocks: [], waiting: 1, minutes: 0 });
  });
});

describe("work past close", () => {
  it("is drawn after hours up to the limit, and the plan ends where the work does", () => {
    const D = (hhmm: string) => new Date(`2027-11-16T${hhmm}:00Z`);
    const j = (id: string, minutes: number): PlanJob => ({ id, kind: "repair", column: "todo", title: id, customer: null, minutes, startBy: D("09:00"), readyBy: D("18:00"), visitAt: D("09:00"), noDate: false, notHereYet: false, mechanicId: "1", mechanic: "Gray", assignable: true });
    const plan = planDay({ jobs: [j("a", 120), j("b", 120), j("c", 600)], tracks: new Map(), start: D("09:00"), end: D("18:00"), now: D("16:00"), until: D("23:59") });
    expect(plan.lanes[0].blocks.map((b) => [b.jobId, b.start.toISOString().slice(11, 16), b.late])).toEqual([["a", "16:00", false], ["b", "18:00", true], ["c", "20:00", true]]);
    expect(plan.overflow).toBe(0);
    expect(plan.last).toEqual(D("23:59")); // "c" starts at 20:00, runs past the limit and is cut there
    expect(plan.lanes[0].minutes).toBe(120); // only what fits before close counts as today
  });
});
