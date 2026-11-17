import Link from "next/link";
import { notFound } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { bookings, lsWorkorders, staffUsers } from "@/db/schema";
import { Flash } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { formatTime } from "@/lib/time";
import { jobIdFromPath, jobPath, workshopJobs, type WorkshopJob } from "@/lib/workshop";
import { fetchWorkorderLines, forgetWorkorder, linesSubtotal, type WorkorderLine } from "@/lib/workorder-lines";
import { lightspeedWorkorderUrl } from "@/lib/workorders";
import { listTicketPhotos } from "@/lib/tickets";
import { loadJobLog, recordTaskTotal } from "@/lib/job-log";
import { currentStep, deriveTrack, fmtMinutes, jobTasks, openTasks, STEP_LABEL, STEP_ORDER, type JobStep, type Task, type Track } from "@/lib/job-track";
import { jobReadyAction, jobResumeAction, jobStepAction, jobTaskAction, moveJobAction, setBookingStatusAction } from "../../actions";

export const metadata = { title: "Job" };

const money = (n: number) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n);
const label = "text-[11px] font-extrabold tracking-wider text-[#3d3f43] uppercase";
const SKIP_REASONS = ["Not needed", "Customer declined", "Done another way", "Couldn't get the part"];

/**
 * One repair, laid out for the iPad on the bench: the steps on the left (Check in → Inspection → Repair → Pickup,
 * with the time each took), the step in hand in the middle (its tasks, ticked one tap at a time), and the customer,
 * the money and one Next step button on the right. Every tap is a time stamp (lib/job-track.ts).
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
  const read = job.workorderId ? await fetchWorkorderLines(db, job.workorderId) : { status: "ok" as const, lines: [] };
  if (read.status === "gone" && job.workorderId) {
    // Deleted in Lightspeed: take it off the board now and say so, instead of showing an error.
    await forgetWorkorder(db, job.workorderId);
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-border bg-card p-6 text-center">
        <p className="text-lg font-bold">Work order #{job.workorderId} was deleted in Lightspeed</p>
        <p className="mt-1 text-sm text-muted">It&apos;s been taken off the Workshop board.</p>
        <Link href="/app/workshop" className="btn btn-primary mt-4">Back to the Workshop</Link>
      </div>
    );
  }
  const lines = read.status === "ok" ? read.lines : null;
  const failReason = read.status === "failed" ? read.reason : null;
  const tasks = lines ? jobTasks(lines) : [];
  if (lines && job.workorderId) await recordTaskTotal(db, { showroomId: showroom.id, workorderId: job.workorderId, total: tasks.length });
  const log = job.workorderId ? await loadJobLog(db, job.workorderId) : [];
  const track = deriveTrack(log, now, Object.fromEntries(tasks.map((t) => [t.key, t.minutes])));
  const step = job.notHereYet ? null : currentStep(track, job.column);
  const actorIds = [...new Set(log.map((e) => e.actor).filter((a): a is string => !!a))];
  const names = new Map((actorIds.length ? await db.select({ id: staffUsers.id, name: staffUsers.name }).from(staffUsers).where(inArray(staffUsers.id, actorIds)) : []).map((u) => [u.id, u.name.split(/\s+/)[0]]));
  const subtotal = lines ? linesSubtotal(lines) : null;
  const self = jobPath(job.id);
  const first = job.customer?.split(/\s+/)[0] ?? "the customer";
  const said = booking?.customerNote || wo?.note || "";
  const photos = job.workorderId ? await listTicketPhotos(db, job.workorderId) : [];
  const lsUrl = job.workorderId ? lightspeedWorkorderUrl(job.workorderId) : null;
  const open = openTasks(tasks, track);
  const booked = tasks.reduce((s, t) => s + (t.minutes ?? 0), 0);
  const readying = sp(q.ready) === "1" && step === "repair";

  return (
    <div>
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link href="/app/workshop" className="text-sm underline">← Workshop</Link>
          <h1 className="mt-1 text-2xl font-extrabold">{[job.tag && `Tag ${job.tag}`, job.customer ?? "Shop bike", wo?.item || job.title].filter(Boolean).join(" · ")}</h1>
          <p className="text-sm text-muted">{[job.workorderId && `Work order #${job.workorderId}`, job.mechanic, !job.noDate && `ready by ${formatTime(job.readyBy, tz)}`, (wo?.hookIn || wo?.hookOut) && `hook ${[wo?.hookIn, wo?.hookOut].filter(Boolean).join(" / ")}`].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {track.handsOn > 0 && <span className="rounded-lg bg-[#17181a] px-3 py-2 text-sm font-bold text-white">Hands-on {fmtMinutes(track.handsOn)}{booked ? ` · booked ${fmtMinutes(booked)}` : ""}</span>}
          {lsUrl && <a href={lsUrl} target="_blank" rel="noreferrer" className="btn">Open in Lightspeed</a>}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)_300px]">
        <Steps job={job} step={step} track={track} tz={tz} />

        <section aria-label={step ? STEP_LABEL[step] : "Booked"} className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-card p-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-lg font-extrabold">{step ? STEP_LABEL[step] : "Booked, not here yet"}</h2>
            {step && track.stepAt[step] && <span className="text-sm text-muted">started {formatTime(track.stepAt[step]!, tz)}</span>}
          </div>
          {job.column === "parts" && <p className="rounded-lg bg-[#f7f6f3] px-3 py-2 text-sm"><strong>Waiting on parts.</strong> The clock has stopped; Parts in starts it again.</p>}
          {!track.running && track.pauseReason === "Started another bike" && step !== "pickup" && <p className="rounded-lg bg-[#f7f6f3] px-3 py-2 text-sm"><strong>Paused</strong> when {track.activeActor ? names.get(track.activeActor) ?? "the mechanic" : "the mechanic"} started another bike. Tick a task or press Resume to carry on.</p>}

          {said && (
            <div>
              <p className={label}>{step === "pickup" ? "They said" : "What they said"}</p>
              <p className="mt-1 whitespace-pre-line">{said}</p>
            </div>
          )}

          {lines === null ? (
            <p className="text-sm text-red-700">Lightspeed didn&apos;t send the work order&apos;s lines{failReason ? ` (${failReason})` : ""}. Open it in Lightspeed or try again.</p>
          ) : step === "pickup" ? (
            <Done tasks={tasks} track={track} names={names} />
          ) : (
            <TaskList tasks={tasks} track={track} names={names} jobId={job.id} self={self} canTick={step === "inspection" || step === "repair"} />
          )}

          {photos.length > 0 && (
            <div className="mt-auto">
              <p className={label}>Photos</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {photos.map((p, i) => (
                  <a key={p.id} href={`/ticket-photo/${p.id}`} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/ticket-photo/${p.id}`} alt={`Photo ${i + 1}`} className="h-20 w-28 rounded-lg object-cover" />
                  </a>
                ))}
              </div>
            </div>
          )}
        </section>

        <aside aria-label="Customer and next step" className="flex min-w-0 flex-col gap-3">
          <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="cust">
            <p id="cust" className={label}>Customer</p>
            <p className="mt-1 text-base font-extrabold">{job.customer ?? "Shop bike"}</p>
            <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              {booking?.customerPhone && (<><dt className="text-muted">Phone</dt><dd>{booking.customerPhone}{booking.smsConsent ? " · texts OK" : ""}</dd></>)}
              {booking?.customerEmail && (<><dt className="text-muted">Email</dt><dd className="truncate">{booking.customerEmail}</dd></>)}
              {wo?.serial && (<><dt className="text-muted">Serial</dt><dd>{wo.serial}</dd></>)}
            </dl>
            {booking && <Link href={`/app/bookings/${booking.id}`} className="mt-2 inline-block text-sm underline">Booking</Link>}
          </section>

          {lines && lines.length > 0 && (
            <section className="rounded-xl border border-border bg-card p-4">
              {lines.map((l) => <MoneyLine key={l.id} line={l} />)}
              {subtotal !== null && <div className="mt-1 flex justify-between border-t border-border pt-2 font-extrabold"><span>Work order</span><span>{money(subtotal)} + tax</span></div>}
              <p className="mt-1 text-xs text-muted">Tax is added at the register.</p>
            </section>
          )}

          <section className="mt-auto flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
            <p className={label}>Next step</p>
            <NextStep job={job} step={step} track={track} open={open} self={self} first={first} lsUrl={lsUrl} />
          </section>
        </aside>
      </div>

      {readying && open.length > 0 && <ReadyPanel jobId={job.id} self={self} open={open} first={first} canTell={job.kind !== "floor" && !!job.customer} />}
    </div>
  );
}

function Steps({ job, step, track, tz }: { job: WorkshopJob; step: JobStep | null; track: Track; tz: string }) {
  const idx = step ? STEP_ORDER.indexOf(step) : -1;
  const sub = (s: JobStep): string => {
    if (s === "checked_in") return job.notHereYet ? "not here yet" : track.stepAt.checked_in ? formatTime(track.stepAt.checked_in, tz) : "checked in";
    if (s === "inspection") return track.stepMinutes.inspection ? fmtMinutes(track.stepMinutes.inspection) : "";
    if (s === "repair") {
      const done = [...track.tasks.values()].filter((t) => t.status === "done").length;
      return [track.taskTotal ? `${done} of ${track.taskTotal} tasks` : "", track.stepMinutes.repair ? fmtMinutes(track.stepMinutes.repair) : ""].filter(Boolean).join(" · ");
    }
    return track.stepAt.pickup ? `ready ${formatTime(track.stepAt.pickup, tz)}` : "";
  };
  return (
    <nav aria-label="Steps" className="flex flex-col gap-1 rounded-xl border border-border bg-card p-2">
      <ol className="flex flex-col gap-1">
        {STEP_ORDER.map((s, i) => {
          const state = i < idx ? "done" : i === idx ? "now" : "next";
          return (
            <li key={s} aria-current={state === "now" ? "step" : undefined} className={`grid min-h-14 grid-cols-[30px_minmax(0,1fr)] items-center gap-2.5 rounded-lg px-2.5 py-1.5 ${state === "now" ? "bg-[#17181a] text-white" : ""}`}>
              <span aria-hidden className={`flex h-[30px] w-[30px] items-center justify-center rounded-full text-sm font-extrabold ${state === "done" ? "bg-[#015d47] text-white" : state === "now" ? "bg-[#ff6b1a] text-[#17181a]" : "border-2 border-[#cfcbc4] text-muted"}`}>
                {state === "done" ? "✓" : i + 1}
              </span>
              <span className="min-w-0">
                <span className={`block font-bold ${state === "next" ? "text-[#3d3f43]" : ""}`}>{STEP_LABEL[s]}</span>
                {sub(s) && <span className={`block text-xs ${state === "now" ? "text-[#c9ccd1]" : "text-muted"}`}>{sub(s)}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {track.handsOn > 0 && (
        <div className="mt-auto border-t border-border p-2.5 text-sm">
          <p className={`${label} mb-1`}>Time</p>
          <div className="flex justify-between"><span>Inspection</span><span>{fmtMinutes(track.stepMinutes.inspection)}</span></div>
          <div className="flex justify-between"><span>Repair</span><span>{fmtMinutes(track.stepMinutes.repair)}</span></div>
          <p className="mt-1 text-xs text-muted">{track.running ? "Clock running." : "Clock stopped."} Waiting on parts or starting another bike stops it.</p>
        </div>
      )}
    </nav>
  );
}

function TaskList({ tasks, track, names, jobId, self, canTick }: { tasks: Task[]; track: Track; names: Map<string, string>; jobId: string; self: string; canTick: boolean }) {
  const current = tasks.find((t) => !track.tasks.has(t.key));
  return (
    <div>
      <p className={label}>Tasks · the work order&apos;s lines</p>
      <ul className="mt-1">
        {tasks.map((t) => {
          const s = track.tasks.get(t.key);
          const isNow = canTick && track.step === "repair" && current?.key === t.key;
          const row = (
            <>
              <span aria-hidden className={`flex h-[30px] w-[30px] items-center justify-center rounded-lg border-2 font-bold ${s?.status === "done" ? "border-[#015d47] bg-[#015d47] text-white" : s?.status === "skipped" ? "border-[#cfcbc4] bg-[#f7f6f3] text-muted" : isNow ? "border-[#ff6b1a] bg-white" : "border-[#cfcbc4] bg-white"}`}>
                {s?.status === "done" ? "✓" : s?.status === "skipped" ? "–" : ""}
              </span>
              <span className={`min-w-0 text-left ${isNow ? "font-bold" : ""}`}>{t.label}</span>
              <span className="text-right text-[13px] text-muted">
                {s?.status === "done" ? (
                  <>
                    {[s.actor ? names.get(s.actor) : null, s.minutes !== null ? fmtMinutes(s.minutes) : null, t.minutes ? `booked ${fmtMinutes(t.minutes)}` : null].filter(Boolean).join(" · ")}
                    {s.outlier && <span className="ml-1 font-bold text-[#9a3412]">check time</span>}
                  </>
                ) : s?.status === "skipped" ? (
                  `skipped: ${s.reason}`
                ) : isNow ? (
                  <span className="font-bold text-[#9a3412]">now · {fmtMinutes(track.sinceTick)}</span>
                ) : t.key === "qc" ? "always last" : t.minutes ? `booked ${fmtMinutes(t.minutes)}` : ""}
              </span>
            </>
          );
          const cls = "grid min-h-14 w-full grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-[#f1efeb] text-[15px] first:border-t-0";
          return (
            <li key={t.key}>
              {canTick && s?.status !== "skipped" ? (
                <form action={jobTaskAction.bind(null, jobId, t.key, t.label, s?.status !== "done", self)}>
                  <button type="submit" className={cls} aria-label={s?.status === "done" ? `Undo ${t.label}` : `${t.label} done`}>{row}</button>
                </form>
              ) : (
                <div className={cls}>{row}</div>
              )}
            </li>
          );
        })}
      </ul>
      {canTick ? (
        <p className="mt-1 text-xs text-muted">Tap a task when it&apos;s done. Its time is the gap since the last tap.</p>
      ) : (
        <p className="mt-1 text-xs text-muted">Tasks can be ticked once the inspection starts.</p>
      )}
    </div>
  );
}

function Done({ tasks, track, names }: { tasks: Task[]; track: Track; names: Map<string, string> }) {
  return (
    <div>
      <p className={label}>What was done</p>
      <ul className="mt-1">
        {tasks.map((t) => {
          const s = track.tasks.get(t.key);
          return (
            <li key={t.key} className="grid min-h-11 grid-cols-[26px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-[#f1efeb] text-[15px] first:border-t-0">
              <span aria-hidden className={`flex h-6 w-6 items-center justify-center rounded-md text-sm font-bold ${s?.status === "done" ? "bg-[#015d47] text-white" : "bg-[#f1efeb] text-muted"}`}>{s?.status === "done" ? "✓" : "–"}</span>
              <span>{t.label}</span>
              <span className="text-[13px] text-muted">
                {s?.status === "done" ? [s.actor ? names.get(s.actor) : null, s.minutes !== null ? fmtMinutes(s.minutes) : null].filter(Boolean).join(" · ") : s?.status === "skipped" ? `skipped: ${s.reason}` : "not ticked"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MoneyLine({ line }: { line: WorkorderLine }) {
  return (
    <div className="flex justify-between gap-2 py-1 text-sm">
      <span className="min-w-0">{line.description}{line.qty !== 1 ? ` × ${line.qty}` : ""}</span>
      <span>{line.unitPrice !== null ? money(line.unitPrice * line.qty) : "—"}</span>
    </div>
  );
}

const big = "flex min-h-[72px] w-full flex-col items-center justify-center rounded-xl bg-[#ff6b1a] px-3 text-center text-[#17181a]";

/** The one big button for where the job is now, plus Waiting on parts / Resume when they apply. */
function NextStep({ job, step, track, open, self, first, lsUrl }: { job: WorkshopJob; step: JobStep | null; track: Track; open: Task[]; self: string; first: string; lsUrl: string | null }) {
  const title = (t: string, sub?: string) => (<><span className="text-lg font-extrabold">{t}</span>{sub && <span className="text-xs font-semibold">{sub}</span>}</>);
  const parts = (
    <form action={moveJobAction.bind(null, job.id, "parts", self)}>
      <button type="submit" className="btn min-h-12 w-full">Waiting on parts</button>
    </form>
  );
  if (!job.workorderId) return <p className="text-sm text-muted">No Lightspeed work order yet. Open the booking and press Create it now.</p>;
  if (job.notHereYet && job.bookingId) {
    return (
      <form action={setBookingStatusAction.bind(null, job.bookingId, "completed", self)}>
        <button type="submit" className={big}>{title("Check in →", "Step 1 of 4")}</button>
      </form>
    );
  }
  if (job.column === "parts") {
    return (
      <form action={moveJobAction.bind(null, job.id, "doing", self)}>
        <button type="submit" className={big}>{title("Parts in · back to work →", "Starts the clock again")}</button>
      </form>
    );
  }
  const resume = !track.running && track.pauseReason === "Started another bike" && (step === "inspection" || step === "repair") && (
    <form action={jobResumeAction.bind(null, job.id, self)}>
      <button type="submit" className="btn min-h-12 w-full">Resume this job</button>
    </form>
  );
  if (step === "checked_in") {
    return (
      <form action={jobStepAction.bind(null, job.id, "inspection", self)}>
        <button type="submit" className={big}>{title("Start inspection →", "Step 2 of 4")}</button>
      </form>
    );
  }
  if (step === "inspection") {
    return (
      <>
        {resume}
        <form action={jobStepAction.bind(null, job.id, "repair", self)}>
          <button type="submit" className={big}>{title("Inspection done · start repair →", "Step 3 of 4")}</button>
        </form>
        {parts}
      </>
    );
  }
  if (step === "repair") {
    const canTell = job.kind !== "floor" && !!job.customer;
    return (
      <>
        {resume}
        {open.length > 0 ? (
          <Link href={`${self}?ready=1`} className={big}>{title("Mark ready →", `Step 4 of 4 · ${open.length} task${open.length === 1 ? "" : "s"} left`)}</Link>
        ) : (
          <form action={jobReadyAction.bind(null, job.id, self)} className="grid gap-2">
            {canTell && (
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" name="notify" defaultChecked className="h-5 w-5" /> Tell {first} it&apos;s ready (text or email)
              </label>
            )}
            <button type="submit" className={big}>{title("Mark ready →", "Step 4 of 4")}</button>
          </form>
        )}
        {parts}
        <p className="text-xs text-muted">Mark ready moves the card to Ready{canTell ? ` and can tell ${first} through Klaviyo` : ""}.</p>
      </>
    );
  }
  return lsUrl ? (
    <>
      <a href={lsUrl} target="_blank" rel="noreferrer" className={big}>{title("Take payment →", "Opens the work order at the register")}</a>
      <p className="text-xs text-muted">Once it&apos;s paid in Lightspeed, the job leaves the board on its own.</p>
    </>
  ) : null;
}

/** Mark ready with tasks still open: each one is skipped with a reason, so nothing is silently left undone. */
function ReadyPanel({ jobId, self, open, first, canTell }: { jobId: string; self: string; open: Task[]; first: string; canTell: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <section role="dialog" aria-labelledby="ready-title" className="w-full max-w-lg rounded-2xl bg-card p-5 shadow-xl">
        <h2 id="ready-title" className="text-lg font-extrabold">{open.length} task{open.length === 1 ? "" : "s"} not ticked</h2>
        <p className="mt-1 text-sm text-muted">Tick {open.length === 1 ? "it" : "them"} on the job, or say why {open.length === 1 ? "it was" : "they were"} skipped. Skips are kept on the job.</p>
        <form action={jobReadyAction.bind(null, jobId, self)} className="mt-4 grid gap-3">
          {open.map((t) => (
            <label key={t.key} className="grid gap-1">
              <input type="hidden" name="skip" value={`${t.key}|${t.label}`} />
              <span className="font-semibold">{t.label}</span>
              <select name={`reason:${t.key}`} defaultValue="Not needed" className="input h-11 text-base">
                {SKIP_REASONS.map((r) => <option key={r}>{r}</option>)}
              </select>
            </label>
          ))}
          {canTell && (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="notify" defaultChecked className="h-5 w-5" /> Tell {first} it&apos;s ready (text or email)
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Link href={self} className="btn">Back to the tasks</Link>
            <button type="submit" className="btn btn-primary">Skip and mark ready</button>
          </div>
        </form>
      </section>
    </div>
  );
}
