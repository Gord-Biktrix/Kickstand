/**
 * When a new repair can be ready: the work already waiting is shared across the store's benches, the new job goes
 * on the bench that frees up first, and the clock only runs while the store is open (Settings › Availability).
 * Pure, so the New ticket screen can recompute it as lines are added.
 */
import { addLocalDays, localToUtc, toLocalDate } from "./time";

export type WeeklyHours = Record<string, [string, string][]>;

type QueueJob = { column: string; minutes: number; startBy: Date; readyBy: Date; notHereYet: boolean; noDate: boolean; kind?: string };

/**
 * Minutes of work queued on each bench right now, least loaded first. Counts jobs on the bench or waiting to start
 * (To do, In progress) that should start within the next day; a job in progress counts only its time left.
 * Waiting on parts, ready, bookings that haven't arrived, shop floor bikes (they fill gaps), jobs with no due date
 * and jobs more than two days overdue (old work orders nobody closed) don't hold a bench.
 */
export function benchLoads(jobs: QueueJob[], benches: number, now: Date): number[] {
  const horizon = now.getTime() + 24 * 60 * 60 * 1000;
  const stale = now.getTime() - 2 * 24 * 60 * 60 * 1000;
  const work = jobs
    .filter((j) => (j.column === "todo" || j.column === "doing") && !j.notHereYet && !j.noDate && j.kind !== "floor" && j.startBy.getTime() <= horizon && j.readyBy.getTime() >= stale)
    .map((j) => (j.column === "doing" ? Math.max(0, Math.min(j.minutes, Math.round((j.readyBy.getTime() - now.getTime()) / 60_000))) : j.minutes))
    .sort((a, b) => b - a);
  const loads = Array.from({ length: Math.max(1, benches) }, () => 0);
  for (const m of work) {
    const i = loads.indexOf(Math.min(...loads));
    loads[i] += m;
  }
  return loads.sort((a, b) => a - b);
}

/** Walk `minutes` of open-shop time forward from `from`. With no hours set, plain clock time. */
export function addOpenMinutes(from: Date, minutes: number, hours: WeeklyHours, tz: string): Date {
  if (!Object.values(hours).some((w) => w.length)) return new Date(from.getTime() + minutes * 60_000);
  let left = minutes;
  let cursor = from;
  let day = toLocalDate(from, tz);
  for (let i = 0; i < 60; i++, day = addLocalDays(day, 1)) {
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    for (const [s, e] of hours[String(weekday)] ?? []) {
      const open = localToUtc(day, s, tz);
      const close = localToUtc(day, e, tz);
      const start = cursor > open ? cursor : open;
      if (start >= close) continue;
      const avail = (close.getTime() - start.getTime()) / 60_000;
      if (left <= avail) return new Date(start.getTime() + left * 60_000);
      left -= avail;
      cursor = close;
    }
  }
  return new Date(from.getTime() + minutes * 60_000);
}

/** Ready-by for a new job of `work` minutes: after the least-loaded bench's queue, in open hours, rounded up to 15 minutes. */
export function estimateReady(args: { now: Date; work: number; loads: number[]; hours: WeeklyHours; tz: string }): Date {
  const ahead = args.loads.length ? Math.min(...args.loads) : 0;
  const done = addOpenMinutes(args.now, ahead + args.work, args.hours, args.tz);
  return new Date(Math.ceil(done.getTime() / 900_000) * 900_000);
}
