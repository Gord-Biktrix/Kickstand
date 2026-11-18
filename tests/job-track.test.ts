import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { loadJobLog, logJob, recordTaskTotal, syncColumnMove } from "@/lib/job-log";
import { deriveTrack, entryForColumn, fmtMinutes, jobTasks, openTasks, QC_TASK, type LogEntry } from "@/lib/job-track";
import type { ShowroomCtx } from "@/lib/showroom";
import { resetDb, testDb } from "./helpers";

const T0 = new Date("2027-11-16T22:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const JORDAN = "11111111-1111-4111-8111-111111111111";
const SAM = "22222222-2222-4222-8222-222222222222";

describe("job tracker rules", () => {
  it("runs the clock in inspection and repair, and times each task from the last tick", () => {
    const log: LogEntry[] = [
      { kind: "step", step: "inspection", actor: JORDAN, at: at(0) },
      { kind: "step", step: "repair", actor: JORDAN, at: at(6) },
      { kind: "task_done", taskKey: "l1", taskLabel: "Tune-up", actor: JORDAN, at: at(54) },
      { kind: "task_done", taskKey: "i2", taskLabel: "Pads", actor: JORDAN, at: at(68) },
    ];
    const t = deriveTrack(log, at(71));
    expect(t.step).toBe("repair");
    expect(t.running).toBe(true);
    expect(t.stepMinutes).toEqual({ inspection: 6, repair: 65 });
    expect(t.handsOn).toBe(71);
    expect(t.tasks.get("l1")).toMatchObject({ status: "done", minutes: 48, actor: JORDAN });
    expect(t.tasks.get("i2")?.minutes).toBe(14);
    expect(t.activeActor).toBe(JORDAN);
  });

  it("stops the clock while paused and doesn't charge the pause to the next task", () => {
    const log: LogEntry[] = [
      { kind: "step", step: "repair", actor: JORDAN, at: at(0) },
      { kind: "pause", reason: "Waiting on parts", at: at(10) },
      { kind: "resume", actor: JORDAN, at: at(70) },
      { kind: "task_done", taskKey: "l1", taskLabel: "Flat fix", actor: JORDAN, at: at(75) },
    ];
    const t = deriveTrack(log, at(80));
    expect(t.stepMinutes.repair).toBe(20);
    expect(t.tasks.get("l1")?.minutes).toBe(15);
    const paused = deriveTrack(log.slice(0, 2), at(40));
    expect(paused).toMatchObject({ running: false, pauseReason: "Waiting on parts", handsOn: 10 });
  });

  it("stops at pickup, keeps skips with their reason, and undoes a tick", () => {
    const log: LogEntry[] = [
      { kind: "step", step: "repair", actor: JORDAN, at: at(0) },
      { kind: "task_done", taskKey: "l1", taskLabel: "Tune-up", actor: JORDAN, at: at(30) },
      { kind: "task_undone", taskKey: "l1", actor: JORDAN, at: at(31) },
      { kind: "task_skipped", taskKey: "qc", taskLabel: QC_TASK.label, reason: "Customer in a hurry", actor: JORDAN, at: at(40) },
      { kind: "step", step: "pickup", actor: JORDAN, at: at(41) },
      { kind: "tasks", total: 2, at: at(1) },
    ];
    const t = deriveTrack(log, at(300));
    expect(t.running).toBe(false);
    expect(t.stepMinutes.repair).toBe(41);
    expect(t.tasks.has("l1")).toBe(false);
    expect(t.tasks.get("qc")).toMatchObject({ status: "skipped", reason: "Customer in a hurry", minutes: null });
    expect(t.taskTotal).toBe(2);
  });

  it("flags a task that took far too long", () => {
    const log: LogEntry[] = [
      { kind: "step", step: "repair", at: at(0) },
      { kind: "task_done", taskKey: "l1", taskLabel: "Chain lube", at: at(100) },
    ];
    expect(deriveTrack(log, at(101), { l1: 5 }).tasks.get("l1")?.outlier).toBe(true);
    expect(deriveTrack(log, at(101), { l1: 30 }).tasks.get("l1")?.outlier).toBe(false);
  });

  it("turns board moves into steps, pauses and resumes", () => {
    const fresh = deriveTrack([], at(0));
    expect(entryForColumn(fresh, "doing")).toEqual({ kind: "step", step: "inspection" });
    expect(entryForColumn(fresh, "todo")).toBeNull();
    const running = deriveTrack([{ kind: "step", step: "repair", at: at(0) }], at(5));
    expect(entryForColumn(running, "parts")).toEqual({ kind: "pause", reason: "Waiting on parts" });
    expect(entryForColumn(running, "doing")).toBeNull();
    expect(entryForColumn(running, "ready")).toEqual({ kind: "step", step: "pickup" });
    const paused = deriveTrack([{ kind: "step", step: "repair", at: at(0) }, { kind: "pause", at: at(2) }], at(5));
    expect(entryForColumn(paused, "doing")).toEqual({ kind: "resume" });
  });

  it("lists the work order's lines then the quality check, and what's still open", () => {
    const tasks = jobTasks([{ id: "l1", description: "Tune-up", minutes: 60 }, { id: "i2", description: "Pads", minutes: null }]);
    expect(tasks.map((x) => x.key)).toEqual(["l1", "i2", "qc"]);
    const t = deriveTrack([{ kind: "step", step: "repair", at: at(0) }, { kind: "task_done", taskKey: "l1", at: at(10) }], at(11));
    expect(openTasks(tasks, t).map((x) => x.key)).toEqual(["i2", "qc"]);
    expect(fmtMinutes(48)).toBe("48 min");
    expect(fmtMinutes(65)).toBe("1 h 05 min");
  });
});

describe("job tracker storage", () => {
  let db: Db;
  let van: ShowroomCtx;
  beforeAll(async () => { db = await testDb(); });
  afterAll(async () => { await db.$client.end(); });
  beforeEach(async () => { van = await resetDb(db); });

  it("pauses the mechanic's other running job when they start on another", async () => {
    await logJob(db, { showroomId: van.id, workorderId: "100", actor: JORDAN, entry: { kind: "step", step: "repair" }, now: at(0) });
    await logJob(db, { showroomId: van.id, workorderId: "200", actor: SAM, entry: { kind: "step", step: "repair" }, now: at(1) });
    await logJob(db, { showroomId: van.id, workorderId: "300", actor: JORDAN, entry: { kind: "step", step: "inspection" }, now: at(20) });
    const first = deriveTrack(await loadJobLog(db, "100"), at(30));
    expect(first).toMatchObject({ running: false, pauseReason: "Started another bike" });
    expect(first.stepMinutes.repair).toBe(20);
    expect(deriveTrack(await loadJobLog(db, "200"), at(30)).running).toBe(true);
    expect(deriveTrack(await loadJobLog(db, "300"), at(30)).running).toBe(true);
  });

  it("follows board moves and records the task count only when it changes", async () => {
    await syncColumnMove(db, { showroomId: van.id, workorderId: "100", column: "doing", actor: JORDAN, now: at(0) });
    await syncColumnMove(db, { showroomId: van.id, workorderId: "100", column: "parts", actor: JORDAN, now: at(15) });
    await syncColumnMove(db, { showroomId: van.id, workorderId: "100", column: "ready", actor: JORDAN, now: at(40) });
    await recordTaskTotal(db, { showroomId: van.id, workorderId: "100", total: 3, now: at(45) });
    await recordTaskTotal(db, { showroomId: van.id, workorderId: "100", total: 3, now: at(46) });
    const log = await loadJobLog(db, "100");
    expect(log.map((e) => e.kind)).toEqual(["step", "pause", "step", "tasks"]);
    expect(deriveTrack(log, at(50))).toMatchObject({ step: "pickup", running: false, handsOn: 15, taskTotal: 3 });
  });
});

describe("inspection checks", () => {
  it("are timed in Inspection, kept apart from repair tasks, and the repair clock starts fresh", async () => {
    const { repairDone } = await import("@/lib/job-track");
    const log: LogEntry[] = [
      { kind: "step", step: "inspection", at: at(0), actor: JORDAN },
      { kind: "task_done", taskKey: "insp:brakes", taskLabel: "Brakes", at: at(5), actor: JORDAN },
      { kind: "task_done", taskKey: "insp:wheels", taskLabel: "Wheels", at: at(9), actor: JORDAN },
      { kind: "step", step: "repair", at: at(12), actor: JORDAN },
      { kind: "task_done", taskKey: "line1", taskLabel: "Tune Up", at: at(52), actor: JORDAN },
    ];
    const t = deriveTrack(log, at(60));
    expect(t.tasks.get("insp:brakes")?.minutes).toBe(5);
    expect(t.tasks.get("insp:wheels")?.minutes).toBe(4);
    expect(t.tasks.get("line1")?.minutes).toBe(40);
    expect(repairDone(t)).toBe(1);
    expect(t.stepMinutes).toEqual({ inspection: 12, repair: 48 });
  });
});

describe("inspection checklists per service", () => {
  it("a job gets the checks of each service on its work order once, or the store's default", async () => {
    const { jobChecklist, parseChecklist, DEFAULT_CHECKS, checkKey } = await import("@/lib/job-track");
    const lists = { "101": ["Brakes: pads", "Chain wear"], "102": ["Chain wear", "Motor error codes"] };
    const lines = [{ itemId: "101" }, { itemId: "999" }, { itemId: "102" }];
    expect(jobChecklist(lines, lists, null).map((c) => c.label)).toEqual(["Brakes: pads", "Chain wear", "Motor error codes"]);
    expect(jobChecklist([{ itemId: "999" }], lists, null).map((c) => c.label)).toEqual([...DEFAULT_CHECKS]);
    expect(jobChecklist([], lists, ["Test ride"]).map((c) => c.key)).toEqual(["insp:test-ride"]);
    expect(checkKey("Brakes: pads, rotors")).toBe("insp:brakes-pads-rotors");
    expect(parseChecklist("- Brakes\n\n• brakes\n  Tires  \r\nTires")).toEqual(["Brakes", "Tires"]);
  });

  it("each check is answered OK, Worn or Replace; clearing it takes the answer away", async () => {
    const { checkResult } = await import("@/lib/job-track");
    const log: LogEntry[] = [
      { kind: "step", step: "inspection", at: at(0), actor: JORDAN },
      { kind: "task_done", taskKey: "insp:brakes", taskLabel: "Brakes", reason: "replace", at: at(3), actor: JORDAN },
      { kind: "task_done", taskKey: "insp:tires", taskLabel: "Tires", reason: "ok", at: at(4), actor: JORDAN },
      { kind: "task_done", taskKey: "insp:chain", taskLabel: "Chain", reason: "worn", at: at(5), actor: JORDAN },
      { kind: "task_undone", taskKey: "insp:chain", taskLabel: "Chain", at: at(6), actor: JORDAN },
    ];
    const t = deriveTrack(log, at(10));
    expect([checkResult(t, "insp:brakes"), checkResult(t, "insp:tires"), checkResult(t, "insp:chain")]).toEqual(["replace", "ok", null]);
  });
});
