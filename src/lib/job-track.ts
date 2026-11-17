/**
 * The job tracker (phase 1): a repair moves Check in → Inspection → Repair → Pickup, and every tap is a time stamp
 * in job_log. Everything shown (the step, hands-on time, each task's time, who did it) is worked out here from those
 * rows, so it's pure and testable. The DB side is lib/job-log.ts.
 *
 * Timing rules:
 * - The clock runs during Inspection and Repair, unless the job is paused (waiting on parts, or the mechanic
 *   started another bike). Ticking a task, starting a step or Resume restarts it. Pickup stops it.
 * - A task's time is the running time since the last tick (or since Repair started): one tap per task, no timers.
 * - A task over 3 h, or more than three times its booked time plus an hour, is flagged rather than trusted.
 */
export type JobStep = "checked_in" | "inspection" | "repair" | "pickup";
export const STEP_ORDER: JobStep[] = ["checked_in", "inspection", "repair", "pickup"];
export const STEP_LABEL: Record<JobStep, string> = { checked_in: "Check in", inspection: "Inspection", repair: "Repair", pickup: "Pickup" };

export type LogEntry = {
  kind: "step" | "task_done" | "task_undone" | "task_skipped" | "pause" | "resume" | "tasks";
  step?: string | null;
  taskKey?: string | null;
  taskLabel?: string | null;
  reason?: string | null;
  total?: number | null;
  actor?: string | null;
  at: Date;
};

export type TaskState = { key: string; label: string; status: "done" | "skipped"; at: Date; actor: string | null; minutes: number | null; reason: string | null; outlier: boolean };

export type Track = {
  /** Null when nothing has been logged yet (the board column decides, see stepFromColumn). */
  step: JobStep | null;
  stepAt: Partial<Record<JobStep, Date>>;
  running: boolean;
  /** When the clock stopped, and why ("parts", "another bike"…), while paused. */
  pausedAt: Date | null;
  pauseReason: string | null;
  /** Running minutes in each step, and their total. */
  stepMinutes: { inspection: number; repair: number };
  handsOn: number;
  tasks: Map<string, TaskState>;
  taskTotal: number | null;
  /** Who last did something that runs the clock: the mechanic the job belongs to right now. */
  activeActor: string | null;
  /** Running minutes in Repair since the last tick: how long the task in hand has taken so far. */
  sinceTick: number;
};

/** The quality check is always the last task on a repair. */
export const QC_TASK = { key: "qc", label: "Quality check: test ride" } as const;

const minutesBetween = (a: Date, b: Date) => Math.max(0, (b.getTime() - a.getTime()) / 60_000);
const isStep = (s: unknown): s is JobStep => typeof s === "string" && (STEP_ORDER as string[]).includes(s);
const RUNS = new Set(["inspection", "repair"]);

export function isOutlier(minutes: number, booked: number | null | undefined): boolean {
  if (minutes > 180) return true;
  return !!booked && minutes > booked * 3 + 60;
}

/** Work the job's state out of its log rows (any order), as of `now`. `booked` = booked minutes per task key. */
export function deriveTrack(entries: LogEntry[], now: Date, booked: Record<string, number | null> = {}): Track {
  const log = [...entries].sort((a, b) => a.at.getTime() - b.at.getTime());
  const t: Track = { step: null, stepAt: {}, running: false, pausedAt: null, pauseReason: null, stepMinutes: { inspection: 0, repair: 0 }, handsOn: 0, tasks: new Map(), taskTotal: null, activeActor: null, sinceTick: 0 };
  let paused = false;
  let last: Date | null = null;
  let sinceTick = 0; // running minutes in Repair since the last tick
  const advance = (to: Date) => {
    if (last && t.step && RUNS.has(t.step) && !paused) {
      const m = minutesBetween(last, to);
      t.stepMinutes[t.step as "inspection" | "repair"] += m;
      if (t.step === "repair") sinceTick += m;
    }
    last = to;
  };
  const restart = (e: LogEntry) => {
    paused = false;
    t.pausedAt = null;
    t.pauseReason = null;
    if (e.actor) t.activeActor = e.actor;
  };
  for (const e of log) {
    advance(e.at);
    switch (e.kind) {
      case "step":
        if (!isStep(e.step)) break;
        t.step = e.step;
        t.stepAt[e.step] ??= e.at;
        if (e.step === "repair") sinceTick = 0;
        if (RUNS.has(e.step)) restart(e);
        break;
      case "pause":
        if (!paused) {
          paused = true;
          t.pausedAt = e.at;
          t.pauseReason = e.reason ?? null;
        }
        break;
      case "resume":
        restart(e);
        break;
      case "task_done": {
        if (!e.taskKey) break;
        const minutes = t.step === "repair" ? Math.round(sinceTick) : null;
        t.tasks.set(e.taskKey, { key: e.taskKey, label: e.taskLabel ?? e.taskKey, status: "done", at: e.at, actor: e.actor ?? null, minutes, reason: null, outlier: minutes !== null && isOutlier(minutes, booked[e.taskKey]) });
        sinceTick = 0;
        if (t.step && RUNS.has(t.step)) restart(e);
        break;
      }
      case "task_skipped":
        if (e.taskKey) t.tasks.set(e.taskKey, { key: e.taskKey, label: e.taskLabel ?? e.taskKey, status: "skipped", at: e.at, actor: e.actor ?? null, minutes: null, reason: e.reason ?? null, outlier: false });
        break;
      case "task_undone":
        if (e.taskKey) t.tasks.delete(e.taskKey);
        break;
      case "tasks":
        if (typeof e.total === "number") t.taskTotal = e.total;
        break;
    }
  }
  advance(now);
  t.running = !!t.step && RUNS.has(t.step) && !paused;
  t.stepMinutes = { inspection: Math.round(t.stepMinutes.inspection), repair: Math.round(t.stepMinutes.repair) };
  t.handsOn = t.stepMinutes.inspection + t.stepMinutes.repair;
  t.sinceTick = Math.round(sinceTick);
  return t;
}

/** Before anything is logged, the board column says roughly where a job is. */
export function stepFromColumn(column: "todo" | "doing" | "parts" | "ready"): JobStep {
  return column === "todo" ? "checked_in" : column === "ready" ? "pickup" : "repair";
}

/** The step to show: what the log says, else what the column says. */
export function currentStep(track: Track, column: "todo" | "doing" | "parts" | "ready"): JobStep {
  return track.step ?? stepFromColumn(column);
}

export type Task = { key: string; label: string; minutes: number | null };

/** A repair's tasks: the work order's lines, then the quality check. */
export function jobTasks(lines: { id: string; description: string; minutes: number | null }[]): Task[] {
  return [...lines.map((l) => ({ key: l.id, label: l.description, minutes: l.minutes })), { key: QC_TASK.key, label: QC_TASK.label, minutes: null }];
}

/** Tasks not yet ticked or skipped. */
export function openTasks(tasks: Task[], track: Track): Task[] {
  return tasks.filter((x) => !track.tasks.has(x.key));
}

/** "48 min", "1 h 05 min". */
export function fmtMinutes(m: number): string {
  const r = Math.round(m);
  if (r < 60) return `${r} min`;
  return `${Math.floor(r / 60)} h ${String(r % 60).padStart(2, "0")} min`;
}

/**
 * What a board move means for the tracker. Start (→ In progress) begins the inspection if it hadn't; going back to
 * In progress after a pause resumes; Waiting on parts pauses; Ready is Pickup. Moving back to To do logs nothing.
 */
export function entryForColumn(track: Track, column: "todo" | "doing" | "parts" | "ready"): Omit<LogEntry, "at" | "actor"> | null {
  if (column === "doing") {
    if (!track.step || track.step === "checked_in") return { kind: "step", step: "inspection" };
    if (track.step === "pickup") return { kind: "step", step: "repair" };
    return track.running ? null : { kind: "resume" };
  }
  if (column === "parts") return track.running || !track.step || track.step === "checked_in" ? { kind: "pause", reason: "Waiting on parts" } : null;
  if (column === "ready") return track.step === "pickup" ? null : { kind: "step", step: "pickup" };
  return null;
}
