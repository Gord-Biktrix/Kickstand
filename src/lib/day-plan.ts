/**
 * The Workshop's Day view: one lane per mechanic, today's jobs laid out as blocks across the store's open hours.
 * Pure, so the layout is tested and the page only draws it.
 *
 * Placement:
 * - Done today: from when the job started to when it was marked ready (job tracker stamps).
 * - Running: started `handsOn` minutes ago, ends at the later of now and start + booked length.
 * - Waiting on parts: drawn where it stopped only if it stopped today; older ones are just counted on the lane.
 * - Still to do: packed one after another in the mechanic's lane from now (a bike that's here can be worked on
 *   now; a booking that isn't here yet waits for its drop-off), customer work before floor bikes, then by start-by.
 *   A block that ends after its ready-by is late. Jobs that don't fit before close are counted, not drawn.
 * Lanes are the Lightspeed mechanics on the board's work orders, then Unassigned.
 */
export type PlanJob = {
  id: string;
  kind: "build" | "repair" | "floor";
  column: "todo" | "doing" | "parts" | "ready";
  title: string;
  customer: string | null;
  minutes: number;
  startBy: Date;
  readyBy: Date;
  visitAt: Date;
  noDate: boolean;
  notHereYet: boolean;
  mechanicId: string | null;
  mechanic: string | null;
  /** Can be dragged to another mechanic (a Lightspeed work order the board moves). */
  assignable: boolean;
};

export type PlanTrack = { running: boolean; handsOn: number; startedAt: Date | null; readyAt: Date | null; pausedAt: Date | null; label: string | null };

export type Block = { jobId: string; title: string; sub: string; start: Date; end: Date; state: "done" | "running" | "waiting" | "planned"; late: boolean; assignable: boolean };
/** minutes = running and planned work still ahead of now, before close; waiting = jobs on parts not drawn. */
export type Lane = { mechanicId: string | null; name: string; blocks: Block[]; minutes: number; waiting: number };
export type DayPlan = { start: Date; end: Date; lanes: Lane[]; late: number; waiting: number; unassigned: number; overflow: number };

const MIN = 60_000;
const later = (a: Date, b: Date) => (a > b ? a : b);

export function planDay(args: { jobs: PlanJob[]; tracks: Map<string, PlanTrack>; start: Date; end: Date; now: Date }): DayPlan {
  const { start, end, now } = args;
  const laneOf = new Map<string, Lane>();
  const lane = (id: string | null, name: string) => {
    const key = id ?? "";
    let l = laneOf.get(key);
    if (!l) laneOf.set(key, (l = { mechanicId: id, name, blocks: [], minutes: 0, waiting: 0 }));
    return l;
  };
  for (const j of args.jobs) if (j.mechanicId) lane(j.mechanicId, j.mechanic ?? `Employee ${j.mechanicId}`);
  lane(null, "Unassigned");

  let late = 0;
  let waiting = 0;
  let overflow = 0;
  const sub = (j: PlanJob, t?: PlanTrack) => [j.customer, t?.label].filter(Boolean).join(" · ") || `${j.minutes} min`;
  const todo: PlanJob[] = [];
  for (const j of args.jobs) {
    const t = args.tracks.get(j.id);
    const l = lane(j.mechanicId, j.mechanic ?? "");
    if (j.column === "ready") {
      // Only work finished today, with its stamps, is drawn.
      if (t?.readyAt && t.readyAt >= start && t.readyAt <= end) {
        const s = t.startedAt && t.startedAt >= start ? t.startedAt : new Date(t.readyAt.getTime() - Math.max(15, t.handsOn) * MIN);
        l.blocks.push({ jobId: j.id, title: j.title, sub: sub(j, t), start: later(s, start), end: t.readyAt, state: "done", late: false, assignable: false });
      }
      continue;
    }
    if (j.column === "parts") {
      waiting++;
      const stop = t?.pausedAt && t.pausedAt >= start && t.pausedAt <= end ? t.pausedAt : null;
      if (!stop) {
        l.waiting++;
        continue;
      }
      const s = new Date(stop.getTime() - Math.max(30, t?.handsOn ?? 0) * MIN);
      l.blocks.push({ jobId: j.id, title: j.title, sub: "Waiting on parts", start: later(s, start), end: later(stop, new Date(start.getTime() + 30 * MIN)), state: "waiting", late: false, assignable: j.assignable });
      continue;
    }
    if (t?.running) {
      const s = new Date(now.getTime() - t.handsOn * MIN);
      const e = later(now, new Date(s.getTime() + j.minutes * MIN));
      const isLate = !j.noDate && e > j.readyBy;
      if (isLate) late++;
      l.blocks.push({ jobId: j.id, title: j.title, sub: sub(j, t), start: later(s, start), end: e, state: "running", late: isLate, assignable: j.assignable });
      continue;
    }
    todo.push(j);
  }

  // Still to do: packed per lane after whatever is already there, in start-by order.
  todo.sort((a, b) => Number(a.kind === "floor") - Number(b.kind === "floor") || a.startBy.getTime() - b.startBy.getTime());
  for (const j of todo) {
    const l = lane(j.mechanicId, j.mechanic ?? "");
    const busyUntil = l.blocks.filter((b) => b.state === "running" || b.state === "planned").reduce((m, b) => later(m, b.end), later(start, now));
    const s = j.notHereYet ? later(busyUntil, j.visitAt) : busyUntil;
    const e = new Date(s.getTime() + Math.max(15, j.minutes) * MIN);
    if (s >= end) {
      overflow++;
      continue;
    }
    const isLate = !j.noDate && e > j.readyBy;
    if (isLate) late++;
    l.blocks.push({ jobId: j.id, title: j.title, sub: [j.customer, j.notHereYet ? "not here yet" : null, `${Math.round(j.minutes)} min`].filter(Boolean).join(" · "), start: s, end: e, state: "planned", late: isLate, assignable: j.assignable });
  }

  const lanes = [...laneOf.values()]
    .map((l) => ({
      ...l,
      blocks: l.blocks.sort((a, b) => a.start.getTime() - b.start.getTime()),
      minutes: Math.round(l.blocks.filter((b) => b.state === "running" || b.state === "planned").reduce((m, b) => m + Math.max(0, Math.min(b.end.getTime(), end.getTime()) - Math.max(b.start.getTime(), now.getTime())) / MIN, 0)),
    }))
    .filter((l) => l.mechanicId === null || l.blocks.length > 0 || l.waiting > 0)
    .sort((a, b) => (a.mechanicId === null ? 1 : b.mechanicId === null ? -1 : a.name.localeCompare(b.name)));
  const unassigned = lanes.find((l) => l.mechanicId === null)?.blocks.filter((b) => b.state === "planned").length ?? 0;
  return { start, end, lanes, late, waiting, unassigned, overflow };
}

/** Where a time falls across the day, 0–100 (for drawing). */
export function pct(at: Date, plan: { start: Date; end: Date }): number {
  const span = plan.end.getTime() - plan.start.getTime();
  return Math.max(0, Math.min(100, ((at.getTime() - plan.start.getTime()) / span) * 100));
}
