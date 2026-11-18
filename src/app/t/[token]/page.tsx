import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { lsWorkorders } from "@/db/schema";
import { ensureStoreHours } from "@/lib/booking-types";
import { findingPrice, findingTitle, isLevel, loadJobFindings } from "@/lib/findings";
import { LevelMeter } from "@/components/level-meter";
import type { Finding } from "@/db/schema";
import { sp, type SearchParams } from "@/lib/flash";
import { answerOnTrackerAction } from "./actions";
import { loadJobLog } from "@/lib/job-log";
import { currentStep, deriveTrack, repairDone, type JobStep } from "@/lib/job-track";
import { getShowroomById } from "@/lib/showroom";
import { formatInZone, formatTime, localToUtc, toLocalDate } from "@/lib/time";
import { trackerByToken } from "@/lib/tracker";
import { workshopJobs } from "@/lib/workshop";
import { fetchWorkorderLines } from "@/lib/workorder-lines";

export const metadata = { title: "Your repair" };
export const dynamic = "force-dynamic";

const money = (n: number) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n);
const label = "text-[11px] font-extrabold tracking-[.12em] text-[#5b5f66] uppercase";

/**
 * The customer's repair tracker (link from the check-in text): where the bike is, what's being done, anything
 * waiting on their OK, and when it should be ready. Read only; prices are before tax.
 */
export default async function TrackerPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<SearchParams> }) {
  const [{ token }, q] = await Promise.all([params, searchParams]);
  const tracker = await trackerByToken(db, token);
  if (!tracker) {
    return (
      <Shell>
        <h1 className="text-2xl font-extrabold">This link doesn&apos;t work</h1>
        <p className="mt-2 text-muted">It may have been typed wrong. Call the shop and we&apos;ll sort it out.</p>
      </Shell>
    );
  }
  const showroom = await getShowroomById(db, tracker.showroomId);
  const tz = showroom.timezone;
  const now = new Date();
  const today = toLocalDate(now, tz);
  const when = (d: Date) => (toLocalDate(d, tz) === today ? `${formatTime(d, tz)} today` : `${formatInZone(d, tz, "EEE d MMM")}, ${formatTime(d, tz)}`);
  const first = tracker.customerName.split(/\s+/)[0] || "there";
  const job = (await workshopJobs(db, showroom, now, 60)).find((j) => j.workorderId === tracker.workorderId);
  const [wo] = await db.select().from(lsWorkorders).where(eq(lsWorkorders.id, tracker.workorderId));
  const bike = wo?.item ? `your ${wo.item}` : "your bike";
  const Bike = bike.charAt(0).toUpperCase() + bike.slice(1);

  const hours = (await ensureStoreHours(db, showroom))[String(new Date(`${today}T12:00:00Z`).getUTCDay())] ?? [];
  // "Open today until 6 pm" only while it's open.
  const closeAt = hours.length ? localToUtc(today, hours[hours.length - 1][1], tz) : null;
  const openAt = hours.length ? localToUtc(today, hours[0][0], tz) : null;
  const openNow = !!closeAt && !!openAt && now >= openAt && now < closeAt;
  const store = <StoreCard name={showroom.name} address={showroom.addressLine} phone={showroom.phone} openUntil={openNow && closeAt ? formatTime(closeAt, tz) : null} />;

  if (!job || !wo) {
    return (
      <Shell store={showroom.name}>
        <Hero kicker={`Hi ${first}`} title="All done. Thanks for riding with us." sub="This repair is finished and picked up." />
        <div className="mt-3">{store}</div>
      </Shell>
    );
  }

  const log = await loadJobLog(db, tracker.workorderId);
  const track = deriveTrack(log, now);
  const step: JobStep | null = job.notHereYet ? null : currentStep(track, job.column);
  const parts = job.column === "parts";
  const read = await fetchWorkorderLines(db, tracker.workorderId);
  const lines = read.status === "ok" ? read.lines : [];
  const { findings, requests } = await loadJobFindings(db, tracker.workorderId);
  const sent = findings.filter((f) => f.requestId);
  const pending = sent.filter((f) => !f.decision);
  const declined = sent.filter((f) => f.decision === "declined");
  void requests;
  const mechanic = job.mechanic?.split(/\s+/)[0] ?? null;
  const total = lines.reduce((s, l) => s + (l.unitPrice ?? 0) * l.qty, 0);
  const photos = sent.flatMap((f) => f.photoIds);

  const head = parts
    ? { title: `Waiting on a part for ${bike}.`, sub: "We'll carry on as soon as it arrives." }
    : step === "pickup"
      ? { title: `${Bike} is ready.`, sub: "Come by any time we're open." }
      : step === "repair"
        ? { title: `We're working on ${bike}.`, sub: mechanic ? `${mechanic} is on it now.` : "It's on the stand now." }
        : step === "inspection"
          ? { title: `${Bike} is on the stand.`, sub: mechanic ? `${mechanic} is inspecting it now.` : "We're inspecting it now." }
          : step === "checked_in"
            ? { title: `${Bike} is checked in.`, sub: "It's in line. We'll start on it soon." }
            : { title: `See you soon.`, sub: `We're expecting ${bike} ${when(job.visitAt)}.` };

  const order: JobStep[] = ["checked_in", "inspection", "repair", "pickup"];
  const at = step ? order.indexOf(step) : -1;
  const done = repairDone(track);
  const rows: { key: JobStep; title: string; sub: string }[] = [
    { key: "checked_in", title: "Checked in", sub: track.stepAt.checked_in ? when(track.stepAt.checked_in) : wo.timeIn && step ? when(wo.timeIn) : "" },
    { key: "inspection", title: "Inspection", sub: pending.length && at >= 1 && at < 3 ? "Needs your OK" : track.stepAt.inspection ? when(track.stepAt.inspection) : "" },
    { key: "repair", title: "Repair", sub: parts ? "Waiting on a part" : step === "repair" && track.taskTotal ? `${done} of ${track.taskTotal} done` : track.stepAt.repair ? when(track.stepAt.repair) : "" },
    { key: "pickup", title: "Ready for pickup", sub: track.stepAt.pickup ? `Ready since ${when(track.stepAt.pickup)}` : job.noDate ? "" : `About ${when(job.readyBy)}` },
  ];

  const stepsCard = (
    <section aria-label="Where it's at" className="rounded-2xl bg-white p-4">
      <p className={label}>Where it&apos;s at</p>
      <ol className="mt-2">
        {rows.map((r, i) => {
          const state = i < at || (i === at && r.key === "pickup") ? "done" : i === at ? "now" : "next";
          return (
            <li key={r.key} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
              <span className="flex flex-col items-center">
                <span aria-hidden className={`mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-sm font-extrabold ${state === "done" ? "bg-[#015d47] text-white" : state === "now" ? "bg-[#ff6b1a] text-[#17181a]" : "border-2 border-[#cfcbc4] text-[#a8a29e]"}`}>{state === "done" ? "✓" : i + 1}</span>
                {i < rows.length - 1 && <span aria-hidden className={`w-0.5 flex-1 ${i < at ? "bg-[#015d47]" : "bg-[#e4e1dc]"}`} />}
              </span>
              <span className="pb-4">
                <span className={`block font-bold ${state === "next" ? "text-[#8a8f96]" : ""}`}>{r.title}{state === "now" && <span className="sr-only"> (now)</span>}</span>
                {r.sub && <span className={`block text-sm ${r.sub === "Needs your OK" ? "font-bold text-[#9a3412]" : "text-muted"}`}>{r.sub}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );

  return (
    <Shell store={showroom.name}>
      <div className="grid gap-3 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:items-start">
        <div className="flex flex-col gap-3">
          <Hero kicker={`Hi ${first}`} title={head.title} sub={head.sub} />
          {stepsCard}
          <div className="hidden md:block">{store}</div>
        </div>

        <div className="flex flex-col gap-3">
          {pending.length > 0 && (
            <section id="found" aria-label="Needs your OK" className="scroll-mt-4 rounded-2xl bg-[#e0f354] p-4 text-[#17181a]">
              <h2 className="text-xl leading-tight font-extrabold">We found {pending.length === 1 ? "something" : `${pending.length} things`}. Want us to fix {pending.length === 1 ? "it" : "them"}?</h2>
              <p className="mt-1 text-sm">The rest of the work carries on while you decide.</p>
              {sp(q.error) === "pick" && <p className="mt-2 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-[#9f1d1d]">Choose yes or no first.</p>}
              <form action={answerOnTrackerAction.bind(null, token)} className="mt-3 flex flex-col gap-2.5">
                {pending.map((f) => <FindingCard key={f.id} f={f} token={token} />)}
                <button type="submit" className="min-h-14 rounded-xl bg-[#17181a] text-lg font-extrabold text-white">Confirm</button>
              </form>
            </section>
          )}
          {sp(q.answered) === "1" && pending.length === 0 && (
            <p id="found" className="scroll-mt-4 rounded-2xl bg-[#015d47] p-4 font-bold text-white">Thanks, we&apos;ve got your answer. We&apos;ll let you know when it&apos;s ready.</p>
          )}

          {(lines.length > 0 || declined.length > 0) && (
            <section aria-label="What we're doing" className="rounded-2xl bg-white p-4">
              <p className={label}>What we&apos;re doing</p>
              <ul className="mt-2">
                {lines.map((l) => (
                  <li key={l.id} className="flex justify-between gap-3 py-1.5">
                    <span className="min-w-0">{l.description}{l.qty !== 1 ? ` × ${l.qty}` : ""}</span>
                    <span className="tabular-nums">{l.unitPrice !== null ? money(l.unitPrice * l.qty) : ""}</span>
                  </li>
                ))}
                {declined.map((f) => (
                  <li key={f.id} className="flex justify-between gap-3 py-1.5 text-muted">
                    <span className="min-w-0">{findingTitle(f.items)} · you said not this time</span>
                    <span className="tabular-nums line-through">{money(findingPrice(f.items))}</span>
                  </li>
                ))}
              </ul>
              {lines.length > 0 && (
                <p className="mt-2 flex justify-between border-t border-[#f1efeb] pt-2 font-extrabold">
                  <span>So far</span>
                  <span className="tabular-nums">{money(total)}</span>
                </p>
              )}
              <p className="mt-1 text-sm text-muted">Before tax. You pay when you pick up.</p>
            </section>
          )}

          {photos.length > 0 && (
            <section aria-label="From the stand" className="rounded-2xl bg-white p-4">
              <p className={label}>From the stand</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {photos.map((id, i) => <Photo key={id} token={token} id={id} alt={`Photo ${i + 1} from your mechanic`} />)}
              </div>
            </section>
          )}

          <div className="md:hidden">{store}</div>
        </div>
      </div>
    </Shell>
  );
}

/** One thing that was found: level, what, price and the start of why; View more opens the photos, full reason and lines. */
function FindingCard({ f, token }: { f: Finding; token: string }) {
  const title = findingTitle(f.items);
  return (
    <article className="flex flex-col gap-2.5 rounded-xl bg-white p-3.5">
      <div className="flex items-start justify-between gap-3">
        {isLevel(f.level) ? <LevelMeter level={f.level} size="sm" /> : <span />}
        <span className="text-lg font-extrabold tabular-nums">{money(findingPrice(f.items))}</span>
      </div>
      <h3 className="text-[17px] leading-snug font-extrabold">{title}</h3>
      <details className="group">
        <summary className="cursor-pointer list-none text-[15px] [&::-webkit-details-marker]:hidden">
          <span className="line-clamp-2 group-open:hidden">{f.why}</span>
          <span className="mt-1 inline-block font-bold underline group-open:hidden">View more</span>
          <span className="hidden font-bold underline group-open:inline">Show less</span>
        </summary>
        <div className="mt-2 flex flex-col gap-2.5">
          <p className="whitespace-pre-line">{f.why}</p>
          {f.photoIds.length > 0 && <div className="flex flex-wrap gap-2">{f.photoIds.map((id, i) => <Photo key={id} token={token} id={id} alt={`Photo ${i + 1} of ${title}`} />)}</div>}
          {f.items.length > 0 && (
            <ul className="text-sm text-muted">
              {f.items.map((i) => <li key={i.itemId} className="flex justify-between gap-2"><span>{i.name}{i.qty > 1 ? ` × ${i.qty}` : ""}</span><span className="tabular-nums">{i.price !== null ? money(i.price * i.qty) : ""}</span></li>)}
            </ul>
          )}
        </div>
      </details>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={`${title}: yes or no`}>
        <label className="cursor-pointer">
          <input type="radio" name={`d:${f.id}`} value="yes" className="peer sr-only" />
          <span className="flex min-h-12 items-center justify-center rounded-xl border border-[#cfcbc4] font-bold peer-checked:border-2 peer-checked:border-[#015d47] peer-checked:bg-[#015d47] peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-[#015d47]">Yes, fix it</span>
        </label>
        <label className="cursor-pointer">
          <input type="radio" name={`d:${f.id}`} value="no" className="peer sr-only" />
          <span className="flex min-h-12 items-center justify-center rounded-xl border border-[#cfcbc4] font-bold peer-checked:border-2 peer-checked:border-[#17181a] peer-checked:bg-[#f3f0ea] peer-focus-visible:ring-2 peer-focus-visible:ring-[#17181a]">Not this time</span>
        </label>
      </div>
    </article>
  );
}

/** A photo that opens big on this page (no new tab); tap anywhere to close. */
function Photo({ token, id, alt }: { token: string; id: string; alt: string }) {
  const src = `/t/${token}/photo/${id}`;
  return (
    <>
      <a href={`#p-${id}`} className="shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="h-28 w-40 rounded-lg object-cover" />
      </a>
      <a id={`p-${id}`} href="#found" aria-label="Close photo" className="fixed inset-0 z-50 hidden items-center justify-center bg-black/85 p-4 target:flex">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="max-h-full max-w-full rounded-lg object-contain" />
      </a>
    </>
  );
}

function Hero({ kicker, title, sub }: { kicker: string; title: string; sub: string }) {
  return (
    <section className="rounded-2xl bg-[#17181a] px-5 py-6 text-white">
      <p className="text-sm font-semibold text-[#b9bcc2]">{kicker}</p>
      <h1 className="mt-1 text-[30px] leading-[1.05] font-extrabold tracking-tight">{title}</h1>
      <p className="mt-2 text-[#d6d8dc]">{sub}</p>
    </section>
  );
}

function StoreCard({ name, address, phone, openUntil }: { name: string; address: string; phone: string | null; openUntil: string | null }) {
  return (
    <section aria-label="The shop" className="rounded-2xl bg-white p-4">
      <p className="font-extrabold">{name}</p>
      <p className="text-sm text-muted">{address}{openUntil ? ` · Open today until ${openUntil}` : ""}</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {phone && <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="flex min-h-12 items-center justify-center rounded-xl border border-[#cfcbc4] font-bold">Call the shop</a>}
        <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`} target="_blank" rel="noreferrer" className="flex min-h-12 items-center justify-center rounded-xl border border-[#cfcbc4] font-bold">Directions</a>
      </div>
    </section>
  );
}

function Shell({ store, children }: { store?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-[#edebe7]">
      <header className="bg-[#17181a]">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-3">
          <span className="text-sm font-extrabold tracking-widest text-white uppercase">Biktrix</span>
          {store && <span className="text-sm text-[#b9bcc2]">{store}</span>}
        </div>
      </header>
      <main className="mx-auto w-full max-w-md flex-1 px-4 py-4 md:max-w-5xl md:py-6">{children}</main>
    </div>
  );
}
