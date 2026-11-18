import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { lsWorkorders } from "@/db/schema";
import { ensureStoreHours } from "@/lib/booking-types";
import { findingPrice, loadJobFindings } from "@/lib/findings";
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
export default async function TrackerPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
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
        {store}
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
  const pendingUrl = requests.find((r) => pending.some((f) => f.requestId === r.id))?.url ?? null;
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

  return (
    <Shell store={showroom.name}>
      <Hero kicker={`Hi ${first}`} title={head.title} sub={head.sub} />

      {pending.length > 0 && pendingUrl && (
        <a href={pendingUrl} className="mt-3 block rounded-2xl bg-[#e0f354] p-4 text-[#17181a]">
          <span className="block text-lg leading-tight font-extrabold">We found {pending.length === 1 ? "something" : `${pending.length} things`}. Want us to fix {pending.length === 1 ? "it" : "them"}?</span>
          <span className="mt-1 block text-sm">The rest of the work carries on while you decide.</span>
          <span className="mt-3 inline-flex min-h-11 items-center rounded-xl bg-[#17181a] px-4 font-bold text-white">See what we found →</span>
        </a>
      )}

      <section aria-label="Where it's at" className="mt-3 rounded-2xl bg-white p-4">
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

      {(lines.length > 0 || pending.length > 0) && (
        <section aria-label="What we're doing" className="mt-3 rounded-2xl bg-white p-4">
          <p className={label}>What we&apos;re doing</p>
          <ul className="mt-2">
            {lines.map((l) => (
              <li key={l.id} className="flex justify-between gap-3 py-1.5">
                <span className="min-w-0">{l.description}{l.qty !== 1 ? ` × ${l.qty}` : ""}</span>
                <span className="tabular-nums">{l.unitPrice !== null ? money(l.unitPrice * l.qty) : ""}</span>
              </li>
            ))}
            {pending.length > 0 && (
              <li className="flex justify-between gap-3 py-1.5 text-muted">
                <span>{pending.length} more waiting on you</span>
                <span className="tabular-nums">{money(pending.reduce((s, f) => s + findingPrice(f.items), 0))}</span>
              </li>
            )}
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
        <section aria-label="From the stand" className="mt-3 rounded-2xl bg-white p-4">
          <p className={label}>From the stand</p>
          <div className="mt-2 flex gap-2 overflow-x-auto">
            {photos.map((id, i) => (
              <a key={id} href={`/t/${token}/photo/${id}`} target="_blank" rel="noreferrer" className="shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/t/${token}/photo/${id}`} alt={`Photo ${i + 1} from your mechanic`} className="h-28 w-40 rounded-lg object-cover" />
              </a>
            ))}
          </div>
        </section>
      )}

      {store}
    </Shell>
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
    <section aria-label="The shop" className="mt-3 rounded-2xl bg-white p-4">
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
        <div className="mx-auto flex w-full max-w-md items-center justify-between px-4 py-3">
          <span className="text-sm font-extrabold tracking-widest text-white uppercase">Biktrix</span>
          {store && <span className="text-sm text-[#b9bcc2]">{store}</span>}
        </div>
      </header>
      <main className="mx-auto w-full max-w-md flex-1 px-4 py-4">{children}</main>
    </div>
  );
}
