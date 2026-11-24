import Link from "next/link";
import { formatInZone } from "@/lib/time";
import { db } from "@/db/client";
import { BoardDnd } from "@/components/board-dnd";
import { DayDnd } from "@/components/day-dnd";
import { ensureStoreHours } from "@/lib/booking-types";
import { planDay, type DayPlan, type PlanTrack } from "@/lib/day-plan";
import { Empty, Flash, PageHeader } from "@/components/ui";
import { AutoSubmitSelect } from "@/components/auto-submit-select";
import { requireUser } from "@/lib/auth";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { addLocalDays, formatTime, localToUtc, toLocalDate } from "@/lib/time";
import { jobPath, workshopJobs, type JobColumn, type WorkshopJob } from "@/lib/workshop";
import { syncWorkordersIfStale } from "@/lib/workorders";
import { loadJobLogs } from "@/lib/job-log";
import { currentStep, deriveTrack, fmtMinutes, repairDone, STEP_LABEL, type Track } from "@/lib/job-track";
import { markReadyAction, moveJobAction, readyJobAction, setBookingStatusAction, startBuildAction } from "../actions";

export const metadata = { title: "Workshop" };

const RETURN = "/app/workshop";

/** Repairs move through Lightspeed: a work order written there, or the one Kickstand made for a service booking. */
const movable = (j: WorkshopJob) => j.workorderId !== null && (j.source === "lightspeed" || j.kind === "repair");

/**
 * Where a card can be dragged. Repairs: any other column (Ready opens the confirm panel); a booking that hasn't
 * been checked in has to be checked in first. Bikes for pickup: Build, then Ready, as their buttons do.
 */
function movesFor(j: WorkshopJob): JobColumn[] {
  if (movable(j)) return j.notHereYet && j.bookingId ? [] : (["todo", "doing", "parts", "ready"] as const).filter((c) => c !== j.column);
  if (j.unitId) return j.column === "todo" ? ["doing"] : j.column === "doing" ? ["ready"] : [];
  return [];
}

const COLUMNS: { key: JobColumn; label: string; empty: string }[] = [
  { key: "todo", label: "To do", empty: "Nothing waiting to start." },
  { key: "doing", label: "In progress", empty: "Nothing on the bench." },
  { key: "parts", label: "Waiting on parts", empty: "Nothing waiting on parts." },
  { key: "ready", label: "Ready", empty: "Nothing waiting for pickup." },
];

const KIND = {
  build: { label: "Build", color: "#0f766e" },
  repair: { label: "Repair", color: "#b45309" },
  floor: { label: "Floor bike", color: "#a8a29e" },
} as const;

/** "2:00 pm" today, "Fri 8:00 am" later this week, "Tue 3 Nov 8:00 am" when it's past or further out. */
function when(d: Date, tz: string, today: string) {
  const time = formatTime(d, tz);
  const date = toLocalDate(d, tz);
  if (date === today) return time;
  const thisWeek = date > today && date <= addLocalDays(today, 6);
  return `${formatInZone(d, tz, thisWeek ? "EEE" : "EEE d MMM")} ${time}`;
}

function hours(min: number) {
  if (min < 60) return `${min} min`;
  const h = min / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

/** What to do next with every job on the bench, and when to start it so it's ready in time. */
export default async function WorkshopPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  await requireUser("staff");
  const showroom = await currentShowroom();
  const tz = showroom.timezone;
  const now = new Date();
  const today = toLocalDate(now, tz);
  await syncWorkordersIfStale(db, showroom, { now });
  const all = await workshopJobs(db, showroom, now);
  // Mechanic filter: everyone, one person (by Lightspeed employee id), or jobs nobody has yet.
  const mechanics = [...new Map(all.filter((j) => j.mechanicId).map((j) => [j.mechanicId!, j.mechanic ?? `Employee ${j.mechanicId}`])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const mech = sp(q.mech) ?? "";
  const jobs = mech === "none" ? all.filter((j) => !j.mechanicId) : mech ? all.filter((j) => j.mechanicId === mech) : all;
  const back = mech ? `/app/workshop?mech=${encodeURIComponent(mech)}` : RETURN;
  const readying = all.find((j) => j.id === sp(q.ready) && movable(j));
  // The job tracker: each repair's step, tasks done and clock (lib/job-track.ts).
  const logs = await loadJobLogs(db, jobs.filter((j) => movable(j) && j.workorderId).map((j) => j.workorderId!));
  const tracks = new Map([...logs].map(([wo, entries]) => [wo, deriveTrack(entries, now)]));
  const view = sp(q.view) === "day" ? "day" : "board";
  const viewHref = (v: "board" | "day") => `/app/workshop${[v === "day" ? "view=day" : "", mech ? `mech=${encodeURIComponent(mech)}` : ""].filter(Boolean).join("&").replace(/^/, "?").replace(/^\?$/, "")}`;
  let plan: DayPlan | null = null;
  if (view === "day") {
    // Today's open hours (Settings › Availability), else 9 to 6.
    const hours = await ensureStoreHours(db, showroom);
    const spans = hours[String(new Date(`${today}T12:00:00Z`).getUTCDay())] ?? [];
    const open = spans.length ? spans[0][0] : "09:00";
    const close = spans.length ? spans[spans.length - 1][1] : "18:00";
    const planTracks = new Map<string, PlanTrack>();
    for (const j of jobs) {
      const t = j.workorderId && movable(j) ? tracks.get(j.workorderId) : undefined;
      if (!t) continue;
      const step = currentStep(t, j.column);
      const done = repairDone(t);
      planTracks.set(j.id, { running: t.running, handsOn: t.handsOn, startedAt: t.stepAt.inspection ?? t.stepAt.repair ?? null, readyAt: t.stepAt.pickup ?? null, pausedAt: t.pausedAt, label: [STEP_LABEL[step], step === "repair" && t.taskTotal ? `${done} of ${t.taskTotal}` : null].filter(Boolean).join(" ") });
    }
    plan = planDay({
      jobs: jobs.map((j) => ({ ...j, assignable: movable(j) })),
      tracks: planTracks,
      start: localToUtc(today, open, tz),
      end: localToUtc(today, close, tz),
      // Work past close is still drawn (after hours) up to midnight, so you can see how far behind a lane is.
      until: localToUtc(addLocalDays(today, 1), "00:00", tz),
      now,
    });
  }

  return (
    <div>
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <PageHeader
        title="Workshop"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div role="tablist" aria-label="View" className="inline-flex rounded-lg bg-[#e4e1dc] p-0.5">
              <Link href={viewHref("board")} role="tab" aria-selected={view === "board"} className={`inline-flex min-h-10 items-center rounded-md px-4 text-sm font-bold ${view === "board" ? "bg-[#015d47] text-white" : "text-[#3d3f43]"}`}>Board</Link>
              <Link href={viewHref("day")} role="tab" aria-selected={view === "day"} className={`inline-flex min-h-10 items-center rounded-md px-4 text-sm font-bold ${view === "day" ? "bg-[#015d47] text-white" : "text-[#3d3f43]"}`}>Day</Link>
            </div>
            {mechanics.length > 0 && (
              <form action="/app/workshop">
                {view === "day" && <input type="hidden" name="view" value="day" />}
                <AutoSubmitSelect name="mech" defaultValue={mech} ariaLabel="Mechanic" className="input h-11 w-auto">
                  <option value="">All mechanics</option>
                  {mechanics.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                  <option value="none">Not assigned</option>
                </AutoSubmitSelect>
              </form>
            )}
            <Link href="/app/workshop/new" className="btn btn-primary">+ New ticket</Link>
          </div>
        }
      />
      {readying && <ReadyPanel job={readying} back={back} />}
      {plan ? (
        <DayView plan={plan} jobs={jobs} tz={tz} now={now} back={viewHref("day")} />
      ) : (
      <>
      <BoardDnd back={back}>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((c) => {
          const list = jobs.filter((j) => j.column === c.key);
          return (
            <section key={c.key} data-col={c.key} aria-label={c.label} className="flex min-w-0 flex-col gap-2.5 rounded-lg bg-[#e4e1dc] p-3 transition-colors">
              <h2 className="flex items-center justify-between px-1 text-sm font-bold text-[#3d3f43]">
                {c.label}
                <span className="text-muted">{list.length}</span>
              </h2>
              {list.length === 0 ? <Empty>{c.empty}</Empty> : list.map((j) => <JobCard key={j.id} job={j} tz={tz} today={today} back={back} track={j.workorderId && movable(j) ? tracks.get(j.workorderId) : undefined} />)}
            </section>
          );
        })}
      </div>
      </BoardDnd>
      </>
      )}
    </div>
  );
}

function JobCard({ job, tz, today, back, track }: { job: WorkshopJob; tz: string; today: string; back: string; track?: Track }) {
  const k = KIND[job.kind];
  const timing = job.noDate
    ? job.column === "parts" ? "Waiting on parts" : "No due date"
    : job.column === "parts"
      ? `Due ${when(job.readyBy, tz, today)}`
      : job.column === "todo"
      ? `${job.notHereYet ? "Starts" : "Start by"} ${when(job.startBy, tz, today)}`
      : job.column === "doing"
        ? `Ready by ${when(job.readyBy, tz, today)}`
        : job.source === "lightspeed"
          ? job.status ?? "Ready"
          : "Customer told";
  const detail = job.source === "lightspeed"
    ? [job.customer ?? "Shop bike", job.note, !job.noDate && job.column !== "ready" && `due ${when(job.readyBy, tz, today)}`]
    : job.kind === "build"
      ? [`${hours(job.minutes)} build`, job.column !== "ready" && `ready by ${when(job.readyBy, tz, today)}`, job.customer && `${job.customer} picks up ${when(job.visitAt, tz, today)}`]
      : [hours(job.minutes), job.customer && (job.notHereYet ? `${job.customer} · not here yet, drops off ${when(job.visitAt, tz, today)}` : `${job.customer} · checked in`)];
  const moves = movesFor(job);
  return (
    <article
      data-job={job.id}
      data-unit={job.unitId ?? undefined}
      data-moves={moves.join(",")}
      draggable={moves.length > 0}
      title={moves.length ? "Drag to another column to move it" : undefined}
      className={`rounded-lg border bg-card p-3 ${moves.length ? "cursor-grab active:cursor-grabbing" : ""} ${job.kind === "floor" ? "opacity-75" : ""} ${job.notHereYet ? "border-dashed" : ""} ${job.late ? "border-red-600 shadow-[0_0_0_1px_#dc2626]" : "border-border"}`}>
      <p className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-extrabold tracking-wider uppercase">
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: k.color }} />
          {k.label}
        </span>
        <span className={job.late ? "text-red-700" : "text-foreground"}>
          {timing}
          {job.late && " · late"}
        </span>
      </p>
      <Link href={movable(job) ? jobPath(job.id) : job.href} className="mt-1.5 block font-semibold">
        {job.title}
      </Link>
      <p className="mt-0.5 text-sm text-muted">{detail.filter(Boolean).join(" · ")}</p>
      {track && <TrackLine job={job} track={track} />}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {job.unitId && job.column === "todo" && (
          <form action={startBuildAction.bind(null, job.unitId, RETURN)}>
            <button type="submit" className="btn btn-sm btn-primary">Build</button>
          </form>
        )}
        {job.unitId && job.column === "doing" && (
          <form action={markReadyAction.bind(null, job.unitId, RETURN)}>
            <button type="submit" className="btn btn-sm btn-primary">Ready</button>
          </form>
        )}
        {movable(job) && <MoveButtons job={job} back={back} />}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
        <span className="min-w-0 text-xs text-muted">
          {[job.tag && `tag ${job.tag}`].filter(Boolean).join("")}
          {job.workorderId && (
            <>
              {job.tag ? " · " : ""}
              {job.source === "lightspeed" ? <a href={job.href} target="_blank" rel="noreferrer" className="underline">WO #{job.workorderId}</a> : `WO #${job.workorderId}`}
            </>
          )}
          {job.status && ` · ${job.status}`}
          {job.source === "kickstand" && job.kind === "repair" && <> · <Link href={job.href} className="underline">Open booking</Link></>}
        </span>
        <Mechanic name={job.mechanic} assigned={!!job.mechanicId} />
      </div>
    </article>
  );
}

/**
 * The Day view: one lane per mechanic across today's open hours (lib/day-plan.ts). Blocks link to the job; a
 * Lightspeed work order can be dragged onto another lane to give it to that mechanic.
 */
/** Pixels per hour on the Day view: wide enough to read a block; the day scrolls sideways and opens at now. */
const HOUR_PX = 220;
const LANE_COL = 180;

function DayView({ plan, jobs, tz, now, back }: { plan: DayPlan; jobs: WorkshopJob[]; tz: string; now: Date; back: string }) {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const today = toLocalDate(now, tz);
  const startMs = plan.start.getTime();
  const lastMs = Math.ceil(plan.last.getTime() / 3_600_000) * 3_600_000;
  const x = (d: Date) => Math.max(0, ((Math.min(d.getTime(), lastMs) - startMs) / 3_600_000) * HOUR_PX);
  const trackW = ((lastMs - startMs) / 3_600_000) * HOUR_PX;
  const hourMarks: Date[] = [];
  for (let t = new Date(Math.ceil(startMs / 3_600_000) * 3_600_000); t.getTime() < lastMs; t = new Date(t.getTime() + 3_600_000)) hourMarks.push(t);
  const nowX = now >= plan.start && now.getTime() <= lastMs ? x(now) : null;
  const closeX = x(plan.end);
  const afterHours = closeX < trackW ? <div aria-hidden className="pointer-events-none absolute top-0 bottom-0 bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgba(0,0,0,.035)_6px_12px)]" style={{ left: closeX, width: trackW - closeX }} /> : null;
  const STYLE = {
    done: "border-border bg-[#f3f1ee] text-[#5b5f66]",
    running: "border-2 border-[#17181a] bg-white",
    waiting: "border-border bg-[repeating-linear-gradient(135deg,#f7f6f3_0_8px,#ece9e4_8px_16px)]",
    planned: "border-border bg-white",
  } as const;
  const mark = { done: "✓ ", running: "● ", waiting: "❚❚ ", planned: "" } as const;
  const sticky = "sticky left-0 z-20 border-r border-border";
  return (
    <DayDnd back={back} nowX={nowX}>
      <section aria-label="Day plan" data-scroll className="overflow-x-auto rounded-xl border border-border bg-card">
        <div className="relative" style={{ width: LANE_COL + trackW }}>
          <div className="flex bg-[#f7f6f3]">
            <div className={`${sticky} shrink-0 bg-[#f7f6f3] px-3.5 py-2.5 text-[11px] font-extrabold tracking-wider text-[#3d3f43] uppercase`} style={{ width: LANE_COL }}>Mechanic</div>
            <div className="relative h-9" style={{ width: trackW }}>
              {hourMarks.map((h) => (
                <span key={h.getTime()} className="absolute top-0 h-full border-l border-border pt-2.5 pl-2 text-xs font-bold whitespace-nowrap text-muted" style={{ left: x(h) }}>{formatTime(h, tz).replace(":00", "")}</span>
              ))}
              {closeX < trackW && <span className="absolute top-0 pt-2.5 pl-2 text-xs font-bold whitespace-nowrap text-[#9f1d1d]" style={{ left: closeX + 44 }}>closed</span>}
            </div>
          </div>
          {nowX !== null && (
            <div aria-hidden className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-[#ff6b1a]" style={{ left: LANE_COL + nowX }}>
              <span className="absolute top-1 left-1.5 rounded bg-[#ff6b1a] px-1.5 py-0.5 text-[11px] font-extrabold whitespace-nowrap text-white">{formatTime(now, tz)}</span>
            </div>
          )}
          {plan.lanes.map((l) => (
            <div key={l.mechanicId ?? "none"} data-lane={l.mechanicId ?? ""} className={`flex min-h-[88px] border-t border-border transition-colors ${l.mechanicId ? "" : "bg-[#fbfaf8]"}`}>
              <div className={`${sticky} flex shrink-0 flex-col justify-center gap-1 px-3.5 py-3 ${l.mechanicId ? "bg-card" : "bg-[#fbfaf8]"}`} style={{ width: LANE_COL }}>
                <span className="font-extrabold">{l.name}</span>
                <span className="text-xs text-muted">{[l.minutes ? `${fmtMinutes(l.minutes)} left today` : l.mechanicId ? "Nothing left today" : null, l.waiting ? `❚❚ ${l.waiting} on parts` : null].filter(Boolean).join(" · ")}</span>
              </div>
              <div className="relative" style={{ width: trackW }}>
                {hourMarks.map((h) => <span key={h.getTime()} aria-hidden className="absolute top-0 bottom-0 border-l border-[#f0eeea]" style={{ left: x(h) }} />)}
                {afterHours}
                {l.blocks.map((b) => {
                  const job = byId.get(b.jobId);
                  const left = x(b.start);
                  const width = Math.max(48, x(b.end) - left - 4);
                  return (
                    <Link
                      key={b.jobId}
                      href={job && movable(job) ? jobPath(job.id) : (job?.href ?? "#")}
                      data-job={b.jobId}
                      data-lane={l.mechanicId ?? ""}
                      data-assignable={b.assignable ? "1" : "0"}
                      draggable={b.assignable}
                      title={`${b.title} · ${formatTime(b.start, tz)}–${formatTime(b.end, tz)}${b.assignable ? " · drag to give it to someone" : ""}`}
                      className={`absolute top-3 bottom-3 overflow-hidden rounded-lg border px-2 py-1.5 text-xs leading-tight ${STYLE[b.state]} ${b.late ? "border-2 border-red-600" : ""} ${l.mechanicId ? "" : "border-dashed"} ${b.assignable ? "cursor-grab active:cursor-grabbing" : ""}`}
                      style={{ left: left + 2, width }}
                    >
                      <span className="block truncate text-[13px] font-bold">{mark[b.state]}{b.title}</span>
                      <span className="block truncate text-muted">{b.sub}</span>
                      {b.late && job && <span className="block truncate font-bold text-red-700">{job.readyBy < now ? `was due ${when(job.readyBy, tz, today)}` : `due ${when(job.readyBy, tz, today)} · will be late`}</span>}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>
    </DayDnd>
  );
}

/** "Repair · 2 of 4 · ● 1 h 05 min" or "❚❚ paused at 22 min": where the job is in the tracker, and its clock. */
function TrackLine({ job, track }: { job: WorkshopJob; track: Track }) {
  const step = currentStep(track, job.column);
  const done = repairDone(track);
  const progress = step === "repair" && track.taskTotal ? `${done} of ${track.taskTotal}` : null;
  return (
    <div className="mt-2">
      <p className="flex flex-wrap items-center justify-between gap-2 text-xs font-bold">
        <span>{[STEP_LABEL[step], progress].filter(Boolean).join(" · ")}</span>
        {track.handsOn > 0 && (
          <span className={`rounded-md px-1.5 py-0.5 ${track.running ? "bg-[#fff1e8] text-[#9a3412]" : "bg-[#f3f1ee] text-[#5b5f66]"}`}>
            {track.running ? `● ${fmtMinutes(track.handsOn)}` : step === "pickup" ? fmtMinutes(track.handsOn) : `❚❚ paused at ${fmtMinutes(track.handsOn)}`}
          </span>
        )}
      </p>
      {progress && track.taskTotal ? (
        <div aria-hidden className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[#efede9]"><div className="h-full bg-[#015d47]" style={{ width: `${Math.min(100, (done / track.taskTotal) * 100)}%` }} /></div>
      ) : null}
    </div>
  );
}

/** The mechanic's initials in a dot (full name on hover); a dash when nobody has the job. */
function Mechanic({ name, assigned }: { name: string | null; assigned: boolean }) {
  const initials = name ? name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() : assigned ? "?" : "–";
  return (
    <span title={name ?? (assigned ? "Mechanic" : "Not assigned")} aria-label={name ? `Mechanic: ${name}` : assigned ? "Mechanic assigned" : "Not assigned"} className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold text-white ${assigned ? "bg-[#3d3f43]" : "bg-[#a8a29e]"}`}>
      {initials}
    </span>
  );
}

/** The next step for a repair, as one main button (plus Waiting on parts). Each writes the column's Lightspeed status. */
function MoveButtons({ job, back }: { job: WorkshopJob; back: string }) {
  if (job.notHereYet && job.bookingId) {
    return (
      <form action={setBookingStatusAction.bind(null, job.bookingId, "completed", back)}>
        <button type="submit" className="btn btn-sm btn-primary">Check in</button>
      </form>
    );
  }
  const move = (column: JobColumn, label: string, primary = false) => (
    <form action={moveJobAction.bind(null, job.id, column, back)}>
      <button type="submit" className={`btn btn-sm ${primary ? "btn-primary" : ""}`}>{label}</button>
    </form>
  );
  const ready = <Link href={`${back}${back.includes("?") ? "&" : "?"}ready=${encodeURIComponent(job.id)}`} className="btn btn-sm btn-primary">Ready</Link>;
  if (job.column === "todo") return <>{move("doing", "Start", true)}{move("parts", "Waiting on parts")}</>;
  if (job.column === "doing") return <>{ready}{move("parts", "Waiting on parts")}</>;
  if (job.column === "parts") return move("todo", "Parts in", true);
  return null;
}

/** Ready, confirmed: shows what happens in Lightspeed and lets staff choose whether the customer is told. */
function ReadyPanel({ job, back }: { job: WorkshopJob; back: string }) {
  const canTell = job.kind !== "floor" && !!job.customer;
  const first = job.customer?.split(/\s+/)[0] ?? "the customer";
  return (
    <section role="dialog" aria-labelledby="ready-title" className="mb-4 rounded-lg border-2 border-[#ff6b1a] bg-card p-4">
      <p className="text-[11px] font-extrabold tracking-wider uppercase">Mark ready</p>
      <h2 id="ready-title" className="mt-1 text-lg font-bold">{job.title}{job.customer ? ` · ${job.customer}` : ""}</h2>
      <p className="mt-1 text-sm text-muted">Lightspeed work order #{job.workorderId} moves to the Ready column&apos;s status (Finished unless you changed it in Settings › Views).</p>
      <form action={readyJobAction.bind(null, job.id, back)} className="mt-3 flex flex-wrap items-center gap-3">
        {canTell ? (
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" name="notify" defaultChecked className="h-5 w-5" /> Tell {first} it&apos;s ready (text or email, through Klaviyo)
          </label>
        ) : (
          <p className="text-sm text-muted">Shop bike: nobody to tell.</p>
        )}
        <span className="ml-auto flex gap-2">
          <Link href={back} className="btn">Cancel</Link>
          <button type="submit" className="btn btn-primary">Mark ready</button>
        </span>
      </form>
    </section>
  );
}
