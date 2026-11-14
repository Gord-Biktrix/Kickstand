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
  { key: "ready", label: "Ready", empty: "Nothing waiting for pickup." },
];

const KIND = {
  build: { label: "Build", color: "#0f766e" },
  repair: { label: "Repair", color: "#b45309" },
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
  const jobs = await workshopJobs(db, showroom, now);
  const late = jobs.filter((j) => j.late).length;

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
      />
      <div className="grid gap-3 md:grid-cols-3">
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
        Builds take {hours(showroom.settings.build_minutes)} (change it in Settings › Program); repairs take the service&apos;s length and run while the customer&apos;s appointment does. Ready texts the customer. Jobs leave the board when the visit is completed.
      </p>
    </div>
  );
}

function JobCard({ job, tz, today }: { job: WorkshopJob; tz: string; today: string }) {
  const k = KIND[job.kind];
  const timing =
    job.column === "todo"
      ? `${job.kind === "build" ? "Start by" : "Starts"} ${when(job.startBy, tz, today)}`
      : job.column === "doing"
        ? `Ready by ${when(job.readyBy, tz, today)}`
        : "Customer told";
  const detail =
    job.kind === "build"
      ? [`${hours(job.minutes)} build`, job.column !== "ready" && `ready by ${when(job.readyBy, tz, today)}`, job.customer && `${job.customer} picks up ${when(job.visitAt, tz, today)}`]
      : [hours(job.minutes), job.customer && `${job.customer} drops off ${when(job.visitAt, tz, today)}`];
  return (
    <article className={`rounded-lg border bg-card p-3 ${job.late ? "border-red-600 shadow-[0_0_0_1px_#dc2626]" : "border-border"}`}>
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
      <Link href={job.href} className="mt-1.5 block font-semibold">
        {job.title}
      </Link>
      <p className="mt-0.5 text-sm text-muted">{detail.filter(Boolean).join(" · ")}</p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">{[job.tag && `tag ${job.tag}`, job.workorderId && `WO #${job.workorderId}`].filter(Boolean).join(" · ")}</span>
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
          {job.kind === "repair" && (
            <Link href={job.href} className="btn btn-sm">Open</Link>
          )}
        </span>
      </div>
    </article>
  );
}
