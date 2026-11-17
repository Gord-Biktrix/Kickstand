/**
 * Writing and reading the job tracker's time stamps (job_log). The rules live in lib/job-track.ts; this file only
 * stores taps and does the one cross-job rule: a mechanic runs one job at a time, so starting, resuming or ticking a
 * task on one job pauses any other job that is running in their name.
 */
import { and, asc, eq, gt, inArray, ne, desc } from "drizzle-orm";
import type { Db } from "@/db/client";
import { jobLog } from "@/db/schema";
import { deriveTrack, entryForColumn, type LogEntry } from "./job-track";

const RUNS_CLOCK = (e: Omit<LogEntry, "at">) => e.kind === "resume" || e.kind === "task_done" || (e.kind === "step" && (e.step === "inspection" || e.step === "repair"));

const toEntry = (r: typeof jobLog.$inferSelect): LogEntry => ({ kind: r.kind as LogEntry["kind"], step: r.step, taskKey: r.taskKey, taskLabel: r.taskLabel, reason: r.reason, total: r.total, actor: r.actor, at: r.at });

export async function loadJobLogs(db: Db, workorderIds: string[]): Promise<Map<string, LogEntry[]>> {
  const out = new Map<string, LogEntry[]>();
  if (!workorderIds.length) return out;
  const rows = await db.select().from(jobLog).where(inArray(jobLog.workorderId, workorderIds)).orderBy(asc(jobLog.at));
  for (const r of rows) {
    const list = out.get(r.workorderId) ?? [];
    list.push(toEntry(r));
    out.set(r.workorderId, list);
  }
  return out;
}

export async function loadJobLog(db: Db, workorderId: string): Promise<LogEntry[]> {
  return (await loadJobLogs(db, [workorderId])).get(workorderId) ?? [];
}

/** Record one tap. If it runs the clock, the same mechanic's other running job is paused first. */
export async function logJob(db: Db, args: { showroomId: string; workorderId: string; actor: string | null; entry: Omit<LogEntry, "at" | "actor">; now?: Date }): Promise<void> {
  const now = args.now ?? new Date();
  if (args.actor && RUNS_CLOCK(args.entry)) await pauseOtherJobs(db, { showroomId: args.showroomId, actor: args.actor, except: args.workorderId, now });
  await db.insert(jobLog).values({
    showroomId: args.showroomId,
    workorderId: args.workorderId,
    kind: args.entry.kind,
    step: args.entry.step ?? null,
    taskKey: args.entry.taskKey ?? null,
    taskLabel: args.entry.taskLabel ?? null,
    reason: args.entry.reason ?? null,
    total: args.entry.total ?? null,
    actor: args.actor,
    at: now,
  });
}

async function pauseOtherJobs(db: Db, args: { showroomId: string; actor: string; except: string; now: Date }) {
  const since = new Date(args.now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const touched = await db
    .selectDistinct({ workorderId: jobLog.workorderId })
    .from(jobLog)
    .where(and(eq(jobLog.actor, args.actor), gt(jobLog.at, since), ne(jobLog.workorderId, args.except)));
  if (!touched.length) return;
  const logs = await loadJobLogs(db, touched.map((t) => t.workorderId));
  for (const [workorderId, entries] of logs) {
    const track = deriveTrack(entries, args.now);
    if (track.running && track.activeActor === args.actor) {
      // A millisecond before the new tap, so the order is unambiguous.
      await db.insert(jobLog).values({ showroomId: args.showroomId, workorderId, kind: "pause", reason: "Started another bike", actor: args.actor, at: new Date(args.now.getTime() - 1) });
    }
  }
}

/** Keep the tracker in step with a board move (Start, Waiting on parts, Parts in, Ready, drag and drop). */
export async function syncColumnMove(db: Db, args: { showroomId: string; workorderId: string; column: "todo" | "doing" | "parts" | "ready"; actor: string | null; now?: Date }): Promise<void> {
  const now = args.now ?? new Date();
  const entry = entryForColumn(deriveTrack(await loadJobLog(db, args.workorderId), now), args.column);
  if (entry) await logJob(db, { ...args, entry, now });
}

/** Remember how many tasks the job has (for "2 of 4" on the board), only when it changes. */
export async function recordTaskTotal(db: Db, args: { showroomId: string; workorderId: string; total: number; now?: Date }): Promise<void> {
  const [last] = await db
    .select({ total: jobLog.total })
    .from(jobLog)
    .where(and(eq(jobLog.workorderId, args.workorderId), eq(jobLog.kind, "tasks")))
    .orderBy(desc(jobLog.at))
    .limit(1);
  if (last?.total === args.total) return;
  await db.insert(jobLog).values({ showroomId: args.showroomId, workorderId: args.workorderId, kind: "tasks", total: args.total, actor: null, at: args.now ?? new Date() });
}
