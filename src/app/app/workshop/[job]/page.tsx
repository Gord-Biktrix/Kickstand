import Link from "next/link";
import { notFound } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { bookings, jobTrackers, lsWorkorders, staffUsers } from "@/db/schema";
import { trackerUrl } from "@/lib/tracker";
import { decryptToken } from "@/lib/tokens";
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
import { CHECK_RESULTS, checkResult, currentStep, deriveTrack, fmtMinutes, jobChecklist, jobTasks, openTasks, repairDone, STEP_LABEL, STEP_ORDER, type JobStep, type Task, type Track } from "@/lib/job-track";
import { ConfirmButton } from "@/components/confirm-button";
import { CopyButton } from "@/components/copy-button";
import { FindingSheet } from "@/components/finding-sheet";
import { LevelMeter } from "@/components/level-meter";
import { findingPrice, findingTitle, isLevel, loadJobFindings, type JobFindings } from "@/lib/findings";
import { LightspeedClient, lightspeedEnabled } from "@/lib/lightspeed";
import { loadServiceItems, pickTiles } from "@/lib/service-items";
import { listShowrooms, type ShowroomCtx } from "@/lib/showroom";
import { jobReadyAction, jobResumeAction, jobStepAction, jobStepBackAction, jobTaskAction, jobCheckAction, sendTrackerAction, cancelTicketAction, addFindingAction, deleteFindingAction, sendFindingsAction, staffAnswerFindingAction, findingTakenOffAction, moveJobAction, setBookingStatusAction, staffCancelTypeBookingAction } from "../../actions";

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
  const checks = jobChecklist(lines ?? [], showroom.settings.inspection_checklists, showroom.settings.inspection_default);
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
  const [trackerRow] = job.workorderId ? await db.select({ tokenEnc: jobTrackers.tokenEnc, toldStatus: jobTrackers.toldStatus }).from(jobTrackers).where(eq(jobTrackers.workorderId, job.workorderId)) : [];
  const trackerLink = trackerRow ? trackerUrl(decryptToken(trackerRow.tokenEnc)) : null;
  const trackerTold = trackerRow?.toldStatus ?? null;
  const lsUrl = job.workorderId ? lightspeedWorkorderUrl(job.workorderId) : null;
  const open = openTasks(tasks, track);
  const booked = tasks.reduce((s, t) => s + (t.minutes ?? 0), 0);
  const readying = sp(q.ready) === "1" && step === "repair";
  // Findings: the "+" works on any step while the bike is in the shop.
  const canFind = !!job.workorderId && !!step && step !== "pickup" && !job.notHereYet;
  const jf = job.workorderId ? await loadJobFindings(db, job.workorderId) : null;
  const drafts = jf?.findings.filter((f) => !f.requestId).length ?? 0;
  const adding = canFind && sp(q.add) === "1";
  const tiles = adding ? await findingTiles(showroom) : [];

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
        <Steps job={job} step={step} track={track} tz={tz} checks={checks} />

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
          ) : step === "repair" ? (
            <>
              <TaskList title="Repair · the work order's lines" tasks={tasks} track={track} names={names} jobId={job.id} self={self} canTick />
              <InspectionSummary checks={checks} track={track} />
            </>
          ) : (
            <>
              <CheckList checks={checks} track={track} jobId={job.id} self={self} canAnswer={step === "inspection"} canFind={canFind} />
              <TaskList title="Repair, next · the work order's lines" tasks={tasks} track={track} names={names} jobId={job.id} self={self} canTick={false} muted />
            </>
          )}

          {jf && jf.findings.length > 0 && <Findings jf={jf} jobId={job.id} self={self} first={first} tz={tz} canChangeFindings={step !== "pickup"} />}

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
            {booking && booking.status === "booked" && job.notHereYet ? (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Link href={`/app/bookings/${booking.id}`} className="btn btn-sm">Change time</Link>
                <form action={staffCancelTypeBookingAction.bind(null, booking.id)}>
                  <ConfirmButton className="btn btn-danger btn-sm w-full" message={`Cancel ${booking.customerName}'s booking? They're told through Klaviyo, and the Lightspeed work order is archived.`}>Cancel booking</ConfirmButton>
                </form>
              </div>
            ) : booking ? (
              <Link href={`/app/bookings/${booking.id}`} className="mt-2 inline-block text-sm underline">Booking</Link>
            ) : job.workorderId && job.source === "lightspeed" && step !== "pickup" && !wo?.saleId ? (
              <form action={cancelTicketAction.bind(null, job.id)} className="mt-3">
                <ConfirmButton className="btn btn-danger btn-sm w-full" message={`Cancel this ticket? Work order #${job.workorderId} is archived in Lightspeed and leaves the board. Nobody is texted.`}>Cancel ticket</ConfirmButton>
              </form>
            ) : null}
            {job.workorderId && job.customer && !job.notHereYet && (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#f1efeb] pt-3">
                <span className="mr-auto text-sm">{trackerLink ? `Tracker ${trackerTold === "sent" ? "sent" : "made"}` : "Tracker"}</span>
                {trackerLink && <CopyButton text={trackerLink} label="Copy" />}
                <form action={sendTrackerAction.bind(null, job.id, self)}>
                  <button type="submit" className="btn btn-sm">{trackerTold === "sent" ? "Text again" : "Text it"}</button>
                </form>
                {trackerLink && <a href={trackerLink} target="_blank" rel="noreferrer" className="text-sm underline">View</a>}
              </div>
            )}
          </section>

          {lines && lines.length > 0 && (
            <section className="rounded-xl border border-border bg-card p-4">
              {lines.map((l) => <MoneyLine key={l.id} line={l} />)}
              {subtotal !== null && <div className="mt-1 flex justify-between border-t border-border pt-2 font-extrabold"><span>Work order</span><span>{money(subtotal)} + tax</span></div>}
              <p className="mt-1 text-xs text-muted">Tax is added at the register.</p>
            </section>
          )}

          {canFind && (
            <div className="mt-auto flex justify-end">
              <Link href={`${self}?add=1`} aria-label="Found something extra" title="Found something extra" className="flex h-16 w-16 items-center justify-center rounded-full bg-[#17181a] text-4xl leading-none font-light text-white shadow-[0_6px_16px_rgba(0,0,0,.25)]">+</Link>
            </div>
          )}
          <section className={`${canFind ? "" : "mt-auto "}flex flex-col gap-2 rounded-xl border border-border bg-card p-4`}>
            <p className={label}>Next step</p>
            <NextStep job={job} step={step} track={track} open={open} self={self} first={first} lsUrl={lsUrl} />
            {job.workorderId && job.column !== "parts" && (step === "inspection" || step === "repair" || step === "pickup") && (
              <form action={jobStepBackAction.bind(null, job.id, self)}>
                <button type="submit" className="mt-2 text-sm text-muted underline">← Back to {STEP_LABEL[STEP_ORDER[STEP_ORDER.indexOf(step) - 1]]}</button>
              </form>
            )}
          </section>
        </aside>
      </div>

      {adding && <FindingSheet action={addFindingAction.bind(null, job.id, self)} close={self} first={first} tiles={tiles} drafts={drafts} about={sp(q.about) ?? ""} />}
      {readying && open.length > 0 && <ReadyPanel jobId={job.id} self={self} open={open} first={first} canTell={job.kind !== "floor" && !!job.customer} />}
    </div>
  );
}

function Steps({ job, step, track, tz, checks }: { job: WorkshopJob; step: JobStep | null; track: Track; tz: string; checks: Task[] }) {
  const idx = step ? STEP_ORDER.indexOf(step) : -1;
  const sub = (s: JobStep): string => {
    if (s === "checked_in") return job.notHereYet ? "not here yet" : track.stepAt.checked_in ? formatTime(track.stepAt.checked_in, tz) : "checked in";
    if (s === "inspection") {
      const checked = checks.filter((t) => checkResult(track, t.key)).length;
      return [checked ? `${checked} of ${checks.length} checked` : "", track.stepMinutes.inspection ? fmtMinutes(track.stepMinutes.inspection) : ""].filter(Boolean).join(" · ");
    }
    if (s === "repair") {
      const done = repairDone(track);
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
        </div>
      )}
    </nav>
  );
}

function TaskList({ title, tasks, track, names, jobId, self, canTick, muted }: { title: string; tasks: Task[]; track: Track; names: Map<string, string>; jobId: string; self: string; canTick: boolean; muted?: boolean }) {
  const current = tasks.find((t) => !track.tasks.has(t.key));
  return (
    <div className={muted ? "opacity-60" : ""}>
      <p className={label}>{title}</p>
      <ul className="mt-1">
        {tasks.map((t) => {
          const s = track.tasks.get(t.key);
          const isNow = canTick && track.running && current?.key === t.key;
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
    </div>
  );
}

const RESULT_ON = { ok: "border-[#015d47] bg-[#015d47] text-white", worn: "border-[#b45309] bg-[#b45309] text-white", replace: "border-[#9f1d1d] bg-[#9f1d1d] text-white" } as const;

/** Inspection: each check answered OK, Worn or Replace (tap the chosen one again to clear it). Worn/Replace offer +. */
function CheckList({ checks, track, jobId, self, canAnswer, canFind }: { checks: Task[]; track: Track; jobId: string; self: string; canAnswer: boolean; canFind: boolean }) {
  return (
    <div>
      <p className={label}>Inspection</p>
      <ul className="mt-1">
        {checks.map((c) => {
          const r = checkResult(track, c.key);
          return (
            <li key={c.key} className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t border-[#f1efeb] py-2 text-[15px] first:border-t-0">
              <span className="min-w-0">
                {c.label}
                {canFind && (r === "worn" || r === "replace") && (
                  <Link href={`${self}?add=1&about=${encodeURIComponent(`${c.label}: ${CHECK_RESULTS[r].toLowerCase()}.`)}`} className="ml-2 text-sm font-bold whitespace-nowrap text-[#015d47] underline">+ Add finding</Link>
                )}
              </span>
              <span className="flex gap-1">
                {(Object.keys(CHECK_RESULTS) as (keyof typeof CHECK_RESULTS)[]).map((k) =>
                  canAnswer ? (
                    <form key={k} action={jobCheckAction.bind(null, jobId, c.key, c.label, r === k ? null : k, self)}>
                      <button type="submit" aria-pressed={r === k} className={`min-h-11 min-w-[76px] rounded-lg border px-3 text-sm font-bold ${r === k ? RESULT_ON[k] : "border-[#cfcbc4] bg-white text-[#3d3f43]"}`}>{CHECK_RESULTS[k]}</button>
                    </form>
                  ) : (
                    <span key={k} className={`inline-flex min-h-9 min-w-[64px] items-center justify-center rounded-lg border px-2 text-xs font-bold ${r === k ? RESULT_ON[k] : "border-[#e4e1dc] text-[#a8a29e]"}`}>{CHECK_RESULTS[k]}</span>
                  ),
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** In Repair, the inspection folds to one line: what wasn't OK. */
function InspectionSummary({ checks, track }: { checks: Task[]; track: Track }) {
  const flagged = checks.flatMap((c) => {
    const r = checkResult(track, c.key);
    return r && r !== "ok" ? [`${c.label.split(":")[0]} (${CHECK_RESULTS[r].toLowerCase()})`] : [];
  });
  const ok = checks.filter((c) => checkResult(track, c.key) === "ok").length;
  return <p className="text-sm text-muted">Inspection: {ok} OK{flagged.length ? ` · ${flagged.join(", ")}` : ""}{track.stepMinutes.inspection ? ` · ${fmtMinutes(track.stepMinutes.inspection)}` : ""}.</p>;
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
          <button type="submit" className={big}>{title("Start repair →", "Inspection done · step 3 of 4")}</button>
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
      </>
    );
  }
  return lsUrl ? (
    <>
      <a href={lsUrl} target="_blank" rel="noreferrer" className={big}>{title("Take payment →", "Opens the work order at the register")}</a>
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

/** The store's service tiles for the + sheet (as on New ticket); none when Lightspeed can't be read. */
async function findingTiles(showroom: ShowroomCtx): Promise<{ itemId: string; name: string; price: number | null; minutes: number | null }[]> {
  if (!lightspeedEnabled(showroom)) return [];
  try {
    const others = (await listShowrooms(db)).filter((x) => x.id !== showroom.id).map((x) => `${x.name} ${x.slug}`);
    const items = pickTiles(await loadServiceItems(new LightspeedClient(db)), { selected: showroom.settings.workshop_service_items, store: `${showroom.name} ${showroom.slug}`, otherStores: others });
    return items.map((i) => ({ itemId: i.itemId, name: i.name, price: i.price ?? null, minutes: i.minutes ?? null }));
  } catch {
    return [];
  }
}

/** What was found on this job: drafts (not sent), waiting for an answer, and answered. A branch; never blocks the job. */
function Findings({ jf, jobId, self, first, tz, canChangeFindings }: { jf: JobFindings; jobId: string; self: string; first: string; tz: string; canChangeFindings: boolean }) {
  const latest = jf.requests.at(-1);
  const drafts = jf.findings.filter((f) => !f.requestId);
  return (
    <div>
      <p className={label}>Found extra</p>
      <ul className="mt-1">
        {jf.findings.map((f) => {
          const status = f.decision === "declined" && f.lsAdded ? `Changed to no · take it off the Lightspeed work order` : !f.requestId ? "Not sent" : f.decision === "approved" ? (f.lsError ? `Yes · Lightspeed didn't take it (${f.lsError})` : "Yes · on the work order") : f.decision === "declined" ? "No" : f.decision === "not_asked" ? "No answer · handed over without it" : `Waiting on ${first}`;
          return (
            <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-[#f1efeb] py-2.5 first:border-t-0">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{findingTitle(f.items)} · {money(findingPrice(f.items))}</p>
                <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
                  {isLevel(f.level) && <LevelMeter level={f.level} size="sm" />}
                  <span className={f.decision === "approved" && !f.lsError ? "font-bold text-[#015d47]" : f.lsError || (f.decision === "declined" && f.lsAdded) ? "font-bold text-red-700" : ""}>{status}</span>
                  {f.decidedAt && f.decision !== "not_asked" && <span>{formatTime(f.decidedAt, tz)}</span>}
                </p>
              </div>
              {!f.requestId ? (
                <form action={deleteFindingAction.bind(null, f.id, self)}>
                  <button type="submit" className="btn btn-sm">Remove</button>
                </form>
              ) : !f.decision ? (
                <div className="flex gap-2">
                  <form action={staffAnswerFindingAction.bind(null, f.id, "approved", self)}><button type="submit" className="btn btn-sm">Yes</button></form>
                  <form action={staffAnswerFindingAction.bind(null, f.id, "declined", self)}><button type="submit" className="btn btn-sm">No</button></form>
                </div>
              ) : f.decision === "declined" && f.lsAdded ? (
                <form action={findingTakenOffAction.bind(null, f.id, self)}><button type="submit" className="btn btn-sm">Taken off</button></form>
              ) : (f.decision === "declined" || f.decision === "approved") && canChangeFindings ? (
                <form action={staffAnswerFindingAction.bind(null, f.id, f.decision === "declined" ? "approved" : "declined", self)}>
                  <ConfirmButton className="btn btn-sm" message={f.decision === "declined" ? `Change to yes? Its items go on the Lightspeed work order.` : `Change to no? You'll take its lines off the Lightspeed work order.`}>{f.decision === "declined" ? "Change to yes" : "Change to no"}</ConfirmButton>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {drafts.length > 0 && (
          <form action={sendFindingsAction.bind(null, jobId, self)} className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="sms_consent" defaultChecked className="h-5 w-5" /> Text {first}</label>
            <button type="submit" className="btn btn-primary btn-sm">Send {drafts.length} to {first}</button>
          </form>
        )}
        {latest && <CopyButton text={latest.url} label="Copy their link" />}
      </div>
    </div>
  );
}
