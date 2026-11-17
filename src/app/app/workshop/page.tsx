import Link from "next/link";
import { formatInZone } from "@/lib/time";
import { db } from "@/db/client";
import { BoardDnd } from "@/components/board-dnd";
import { Empty, Flash, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { addLocalDays, formatTime, toLocalDate } from "@/lib/time";
import { jobPath, workshopJobs, type JobColumn, type WorkshopJob } from "@/lib/workshop";
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
  const all = await workshopJobs(db, showroom, now);
  // Mechanic filter: everyone, one person (by Lightspeed employee id), or jobs nobody has yet.
  const mechanics = [...new Map(all.filter((j) => j.mechanicId).map((j) => [j.mechanicId!, j.mechanic ?? `Employee ${j.mechanicId}`])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const mech = sp(q.mech) ?? "";
  const jobs = mech === "none" ? all.filter((j) => !j.mechanicId) : mech ? all.filter((j) => j.mechanicId === mech) : all;
  const late = jobs.filter((j) => j.late).length;
  const ls = showroom.settings.lightspeed.shop_id !== null;
  const back = mech ? `/app/workshop?mech=${encodeURIComponent(mech)}` : RETURN;
  const readying = all.find((j) => j.id === sp(q.ready) && movable(j));

  return (
    <div>
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <PageHeader
        title="Workshop"
        subtitle={
          <>
            Each job shows when to start: when the customer needs it, minus how long the work takes.
            {late > 0 && <span className="ml-1 font-semibold text-red-700">{late} late.</span>}
          </>
        }
        action={
          <div className="flex flex-wrap items-center gap-3">
          <Link href="/app/workshop/new" className="btn btn-primary">+ New ticket</Link>
          {mechanics.length > 0 && (
            <form className="flex items-center gap-2" action="/app/workshop">
              <label htmlFor="mech" className="text-sm text-muted">Mechanic</label>
              <select id="mech" name="mech" defaultValue={mech} className="input h-10 w-auto">
                <option value="">Everyone</option>
                {mechanics.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                <option value="none">Not assigned</option>
              </select>
              <button type="submit" className="btn btn-sm">Show</button>
            </form>
          )}
          </div>
        }
      />
      {readying && <ReadyPanel job={readying} back={back} />}
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
              {list.length === 0 ? <Empty>{c.empty}</Empty> : list.map((j) => <JobCard key={j.id} job={j} tz={tz} today={today} back={back} />)}
            </section>
          );
        })}
      </div>
      </BoardDnd>
      <p className="mt-4 text-sm text-muted">
        Builds take {hours(showroom.settings.build_minutes)} and Lightspeed repairs {hours(showroom.settings.repair_minutes)} before they&apos;re due (change both in Settings › Program); booked repairs run while the customer&apos;s appointment does.
        {ls ? " Lightspeed work orders refresh every hour; which status goes in which column is set in Settings › Views." : ""} Drag a card to another column to move it, or use its buttons. Jobs leave the board when the visit is completed or the work order is paid.
      </p>
    </div>
  );
}

function JobCard({ job, tz, today, back }: { job: WorkshopJob; tz: string; today: string; back: string }) {
  const k = KIND[job.kind];
  const timing = job.noDate
    ? job.column === "parts" ? "Waiting on parts" : "No due date"
    : job.column === "parts"
      ? `Due ${when(job.readyBy, tz, today)}`
      : job.column === "todo"
      ? `${job.kind === "build" ? "Start by" : "Starts"} ${when(job.startBy, tz, today)}`
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
