import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "@/db/client";
import { Empty, Flash, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { addLocalDays, formatTime, toLocalDate } from "@/lib/time";
import { workshopJobs, type JobColumn, type WorkshopJob } from "@/lib/workshop";
import { markReadyAction, startBuildAction } from "../actions";

export const metadata = { title: "Workshop" };

const RETURN = "/app/workshop";

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
  return `${formatInTimeZone(d, tz, thisWeek ? "EEE" : "EEE d MMM")} ${time}`;
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
          mechanics.length > 0 && (
            <form className="flex items-center gap-2" action="/app/workshop">
              <label htmlFor="mech" className="text-sm text-muted">Mechanic</label>
              <select id="mech" name="mech" defaultValue={mech} className="input h-10 w-auto">
                <option value="">Everyone</option>
                {mechanics.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                <option value="none">Not assigned</option>
              </select>
              <button type="submit" className="btn btn-sm">Show</button>
            </form>
          )
        }
      />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((c) => {
          const list = jobs.filter((j) => j.column === c.key);
          return (
            <section key={c.key} aria-label={c.label} className="flex min-w-0 flex-col gap-2.5 rounded-lg bg-[#e4e1dc] p-3">
              <h2 className="flex items-center justify-between px-1 text-sm font-bold text-[#3d3f43]">
                {c.label}
                <span className="text-muted">{list.length}</span>
              </h2>
              {list.length === 0 ? <Empty>{c.empty}</Empty> : list.map((j) => <JobCard key={j.id} job={j} tz={tz} today={today} />)}
            </section>
          );
        })}
      </div>
      <p className="mt-4 text-sm text-muted">
        Builds take {hours(showroom.settings.build_minutes)} and Lightspeed repairs {hours(showroom.settings.repair_minutes)} before they&apos;re due (change both in Settings › Program); booked repairs run while the customer&apos;s appointment does.
        {ls ? " Lightspeed work orders refresh every hour; which status goes in which column is set in Settings › Views." : ""} Jobs leave the board when the visit is completed or the work order is paid.
      </p>
    </div>
  );
}

function JobCard({ job, tz, today }: { job: WorkshopJob; tz: string; today: string }) {
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
      : [hours(job.minutes), job.customer && `${job.customer} drops off ${when(job.visitAt, tz, today)}`];
  return (
    <article className={`rounded-lg border bg-card p-3 ${job.kind === "floor" ? "opacity-75" : ""} ${job.late ? "border-red-600 shadow-[0_0_0_1px_#dc2626]" : "border-border"}`}>
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
      {job.source === "lightspeed" ? (
        <a href={job.href} target="_blank" rel="noreferrer" className="mt-1.5 block font-semibold">{job.title}</a>
      ) : (
        <Link href={job.href} className="mt-1.5 block font-semibold">
          {job.title}
        </Link>
      )}
      <p className="mt-0.5 text-sm text-muted">{detail.filter(Boolean).join(" · ")}</p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">{[job.tag && `tag ${job.tag}`, job.workorderId && `WO #${job.workorderId}`, job.status].filter(Boolean).join(" · ")}</span>
        <span className="flex gap-2">
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
          {job.source === "kickstand" && job.kind === "repair" && (
            <Link href={job.href} className="btn btn-sm">Open</Link>
          )}
          {job.source === "lightspeed" && (
            <a href={job.href} target="_blank" rel="noreferrer" className="btn btn-sm">Lightspeed</a>
          )}
          <Mechanic name={job.mechanic} assigned={!!job.mechanicId} />
        </span>
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
