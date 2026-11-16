import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { bookings, lsWorkorders } from "@/db/schema";
import { Flash } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { formatLongDate, formatTime } from "@/lib/time";
import { jobIdFromPath, jobPath, workshopJobs, type JobColumn, type WorkshopJob } from "@/lib/workshop";
import { fetchWorkorderLines, linesSubtotal, type WorkorderLine } from "@/lib/workorder-lines";
import { lightspeedWorkorderUrl } from "@/lib/workorders";
import { moveJobAction, readyJobAction, setBookingStatusAction } from "../../actions";

export const metadata = { title: "Job" };

const KIND_COLOR = { build: "#0f766e", repair: "#b45309", floor: "#a8a29e" } as const;
const KIND_LABEL = { build: "Build", repair: "Repair", floor: "Floor bike" } as const;
const money = (n: number) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n);
const mins = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`);

/**
 * One job on the Workshop board, in the POS layout: the work order like a cart on the left (customer and bike,
 * where it is, the lines, one big next-step button) and the job's details on the right. Lines are read live from
 * Lightspeed; adding them from Kickstand comes next.
 */
export default async function JobPage({ params, searchParams }: { params: Promise<{ job: string }>; searchParams: Promise<SearchParams> }) {
  const [{ job: ref }, q] = await Promise.all([params, searchParams]);
  await requireUser("staff");
  const showroom = await currentShowroom();
  const tz = showroom.timezone;
  const jobId = jobIdFromPath(ref);
  if (!jobId) notFound();
  const now = new Date();
  const job = (await workshopJobs(db, showroom, now, 60)).find((j) => j.id === jobId);
  if (!job) notFound();
  if (job.unitId) {
    // Bikes for pickup have their own page with the build checklist.
    const { redirect } = await import("next/navigation");
    redirect(job.href);
  }
  const [wo] = job.workorderId ? await db.select().from(lsWorkorders).where(eq(lsWorkorders.id, job.workorderId)) : [];
  const [booking] = job.bookingId ? await db.select().from(bookings).where(eq(bookings.id, job.bookingId)) : [];
  const lines = job.workorderId ? await fetchWorkorderLines(db, job.workorderId) : [];
  const subtotal = lines ? linesSubtotal(lines) : null;
  const self = jobPath(job.id);
  const first = job.customer?.split(/\s+/)[0] ?? "the customer";
  const said = booking?.customerNote || wo?.note || "";
  const lsUrl = job.workorderId ? lightspeedWorkorderUrl(job.workorderId) : null;

  return (
    <div>
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Link href="/app/workshop" className="text-sm underline">← Workshop</Link>
        {lsUrl && <a href={lsUrl} target="_blank" rel="noreferrer" className="text-sm underline">Open in Lightspeed</a>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,430px)_minmax(0,1fr)]">
        {/* The work order, like a POS cart. */}
        <section aria-label="Work order" className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center gap-3 border-b border-border p-4">
            <span aria-hidden className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#17181a] font-bold text-white">
              {(job.customer ?? "Shop").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-lg font-extrabold">{job.customer ?? "Shop bike"}</p>
              <p className="truncate text-sm text-muted">{[job.title, job.tag && `tag ${job.tag}`, job.workorderId && `WO #${job.workorderId}`].filter(Boolean).join(" · ")}</p>
            </div>
          </div>

          <Progress job={job} />

          <div className="flex-1 px-4">
            {lines === null ? (
              <p className="py-4 text-sm text-red-700">Lightspeed didn&apos;t answer, so the parts and labour can&apos;t be shown right now. Open it in Lightspeed or try again.</p>
            ) : lines.length === 0 ? (
              <p className="py-4 text-sm text-muted">No parts or labour on this work order yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {lines.map((l) => <Line key={l.id} line={l} />)}
              </ul>
            )}
            {said && (
              <div className="border-t border-border py-3">
                <p className="text-[11px] font-extrabold tracking-wider text-[#3d3f43] uppercase">What they said</p>
                <p className="mt-1 text-sm whitespace-pre-line">{said}</p>
              </div>
            )}
          </div>

          <div className="border-t border-border p-4">
            {subtotal !== null && (
              <>
                <div className="flex justify-between text-sm text-muted"><span>Before tax</span><span>{money(subtotal)}</span></div>
                <p className="mb-3 text-xs text-muted">Tax is added at the register.</p>
              </>
            )}
            <NextStep job={job} back={self} first={first} lsUrl={lsUrl} />
          </div>
        </section>

        {/* Details, and where adding parts will go. */}
        <div className="flex min-w-0 flex-col gap-4">
          <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="add">
            <h2 id="add" className="text-[11px] font-extrabold tracking-wider text-[#3d3f43] uppercase">Add parts &amp; labour</h2>
            <input disabled placeholder="Search services, parts, labour… (coming soon)" className="input mt-2 h-12" aria-label="Search services, parts and labour (coming soon)" />
            <p className="mt-2 text-sm text-muted">
              Service tiles and adding parts from here come next, once it&apos;s tested on a Lightspeed work order. For now add them in Lightspeed; they show up here straight away.
            </p>
          </section>

          <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="det">
            <h2 id="det" className="text-[11px] font-extrabold tracking-wider text-[#3d3f43] uppercase">Job</h2>
            <dl className="mt-2 grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted">Bike</dt><dd>{wo?.item || job.title}{wo?.serial ? ` · serial ${wo.serial}` : ""}</dd>
              <dt className="text-muted">Status</dt><dd>{job.status ?? "—"}</dd>
              <dt className="text-muted">Mechanic</dt><dd>{job.mechanic ?? (job.mechanicId ? "Someone not in the list" : "Not assigned")}</dd>
              <dt className="text-muted">Date in</dt><dd>{wo?.timeIn ? `${formatLongDate(wo.timeIn, tz)}, ${formatTime(wo.timeIn, tz)}` : job.notHereYet ? "Not here yet" : "—"}</dd>
              <dt className="text-muted">Due</dt><dd>{job.noDate ? "No due date" : `${formatLongDate(job.readyBy, tz)}, ${formatTime(job.readyBy, tz)}`}</dd>
              {(wo?.hookIn || wo?.hookOut) && (<><dt className="text-muted">Hook in / out</dt><dd>{[wo?.hookIn, wo?.hookOut].filter(Boolean).join(" · ")}</dd></>)}
            </dl>
          </section>

          {booking && (
            <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="bk">
              <h2 id="bk" className="text-[11px] font-extrabold tracking-wider text-[#3d3f43] uppercase">Booking</h2>
              <p className="mt-2 text-sm">{formatLongDate(booking.startsAt, tz)}, {formatTime(booking.startsAt, tz)} · {[booking.customerPhone, booking.customerEmail].filter(Boolean).join(" · ")}</p>
              <Link href={`/app/bookings/${booking.id}`} className="mt-2 inline-block text-sm underline">Open the booking (change time, cancel, resend)</Link>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Line({ line }: { line: WorkorderLine }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 py-3">
      <div className="min-w-0">
        <p className="font-semibold">{line.description}</p>
        <p className="text-sm text-muted">
          {[line.kind === "labour" ? "Labour" : "Part", line.minutes ? mins(line.minutes) : null, line.qty !== 1 ? `× ${line.qty}` : null, line.note || null].filter(Boolean).join(" · ")}
        </p>
      </div>
      <p className="font-semibold">{line.unitPrice !== null ? money(line.unitPrice * line.qty) : "—"}</p>
    </li>
  );
}

const STEPS: { key: string; label: string }[] = [
  { key: "in", label: "Checked in" },
  { key: "doing", label: "On the bench" },
  { key: "ready", label: "Ready" },
];

function Progress({ job }: { job: WorkshopJob }) {
  const at: string = job.notHereYet ? "booked" : job.column === "todo" ? "in" : job.column === "parts" ? "doing" : job.column;
  const order = ["booked", "in", "doing", "ready"];
  const idx = order.indexOf(at);
  return (
    <ol aria-label="Where this job is" className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border bg-[#f7f6f3] px-4 py-2.5 text-xs font-bold text-muted">
      <li className="inline-flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-full ${idx >= 0 ? "bg-[#17181a]" : "bg-[#cfcbc4]"}`} aria-hidden /><span className="text-foreground">{KIND_LABEL[job.kind]}</span><i aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: KIND_COLOR[job.kind] }} /></li>
      {STEPS.map((s) => {
        const i = order.indexOf(s.key);
        const state = i < idx ? "done" : i === idx ? "now" : "next";
        return (
          <li key={s.key} aria-current={state === "now" ? "step" : undefined} className={`inline-flex items-center gap-1.5 ${state === "next" ? "" : "text-foreground"}`}>
            <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${state === "done" ? "bg-[#17181a]" : state === "now" ? "bg-[#ff6b1a] ring-2 ring-[#ffd7bf]" : "bg-[#cfcbc4]"}`} />
            {s.key === "doing" && job.column === "parts" ? "Waiting on parts" : s.label}
          </li>
        );
      })}
    </ol>
  );
}

/** The one big button, and the one secondary action, for where the job is now. */
function NextStep({ job, back, first, lsUrl }: { job: WorkshopJob; back: string; first: string; lsUrl: string | null }) {
  const big = "flex min-h-16 w-full items-center justify-center rounded-xl bg-[#ff6b1a] text-lg font-extrabold text-[#17181a]";
  const small = "btn min-h-12 w-full";
  const move = (column: JobColumn, label: string, primary: boolean) => (
    <form action={moveJobAction.bind(null, job.id, column, back)}>
      <button type="submit" className={primary ? big : small}>{label}</button>
    </form>
  );
  if (!job.workorderId) return <p className="text-sm text-muted">No Lightspeed work order yet. Open the booking and press Create it now.</p>;
  if (job.notHereYet && job.bookingId) {
    return (
      <form action={setBookingStatusAction.bind(null, job.bookingId, "completed", back)}>
        <button type="submit" className={big}>Check in</button>
      </form>
    );
  }
  if (job.column === "todo") return <div className="grid gap-2">{move("doing", "Start", true)}{move("parts", "Waiting on parts", false)}</div>;
  if (job.column === "parts") return <div className="grid gap-2">{move("todo", "Parts in", true)}</div>;
  if (job.column === "doing") {
    const canTell = job.kind !== "floor" && !!job.customer;
    return (
      <div className="grid gap-2">
        <form action={readyJobAction.bind(null, job.id, back)} className="grid gap-2">
          {canTell && (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="notify" defaultChecked className="h-5 w-5" /> Tell {first} it&apos;s ready (text or email)
            </label>
          )}
          <button type="submit" className={big}>{canTell ? `Mark ready · tell ${first}` : "Mark ready"}</button>
        </form>
        {move("parts", "Waiting on parts", false)}
      </div>
    );
  }
  return lsUrl ? (
    <a href={lsUrl} target="_blank" rel="noreferrer" className={big}>Take payment · opens Lightspeed</a>
  ) : null;
}
