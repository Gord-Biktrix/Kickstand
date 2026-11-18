import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { lsWorkorders } from "@/db/schema";
import { LevelMeter } from "@/components/level-meter";
import { findingPrice, findingTitle, isLevel, requestByToken } from "@/lib/findings";
import { sp, type SearchParams } from "@/lib/flash";
import { getShowroomById } from "@/lib/showroom";
import { confirmFindingsAction } from "./actions";

export const metadata = { title: "Your bike" };

const money = (n: number) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n);

/**
 * The customer's link from the "Needs your OK" text: what the mechanic found, with photos, why and how strongly
 * it's recommended. Yes or no to each, then Confirm. Answered items show what they chose.
 */
export default async function FindingsPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<SearchParams> }) {
  const [{ token }, q] = await Promise.all([params, searchParams]);
  const found = await requestByToken(db, token);
  if (!found) {
    return (
      <Shell>
        <h1 className="text-2xl font-extrabold">This link doesn&apos;t work</h1>
        <p className="mt-2 text-muted">It may have been typed wrong. Call the shop and we&apos;ll sort it out.</p>
      </Shell>
    );
  }
  const { request, findings } = found;
  const showroom = await getShowroomById(db, request.showroomId);
  const [wo] = await db.select({ item: lsWorkorders.item }).from(lsWorkorders).where(eq(lsWorkorders.id, request.workorderId));
  const first = request.customerName.split(/\s+/)[0] || "there";
  const open = findings.filter((f) => !f.decision);
  const yes = findings.filter((f) => f.decision === "approved");
  const bike = wo?.item ? `your ${wo.item}` : "your bike";

  return (
    <Shell store={showroom.name}>
      <p className="text-sm font-semibold text-muted">Hi {first}</p>
      <h1 className="mt-1 text-[28px] leading-tight font-extrabold">
        {open.length ? `We found ${findings.length === 1 ? "something" : `${findings.length} things`} on ${bike}` : "Thanks, we've got your answer"}
      </h1>
      <p className="mt-2 text-muted">
        {open.length ? "Your booked work carries on either way. Say yes or no to each, then press Confirm." : yes.length ? "We'll add what you said yes to and let you know when it's ready." : "We'll carry on with the booked work and let you know when it's ready."}
      </p>
      {sp(q.error) === "pick" && <p className="mt-3 rounded-lg bg-[#fdecec] px-3 py-2 text-sm text-[#9f1d1d]">Choose yes or no first.</p>}

      <form action={confirmFindingsAction.bind(null, token)} className="mt-5 flex flex-col gap-3">
        {findings.map((f) => (
          <article key={f.id} className="flex flex-col gap-3 rounded-2xl border border-border bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              {isLevel(f.level) ? <LevelMeter level={f.level} /> : <span />}
              <span className="text-lg font-extrabold">{money(findingPrice(f.items))}</span>
            </div>
            <h2 className="text-lg font-extrabold">{findingTitle(f.items)}</h2>
            {f.photoIds.length > 0 && (
              <div className="flex gap-2 overflow-x-auto">
                {f.photoIds.map((id, i) => (
                  <a key={id} href={`/ok/${token}/photo/${id}`} target="_blank" rel="noreferrer" className="shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/ok/${token}/photo/${id}`} alt={`Photo ${i + 1} from your mechanic`} className="h-28 w-40 rounded-lg object-cover" />
                  </a>
                ))}
              </div>
            )}
            <p className="whitespace-pre-line">{f.why}</p>
            {f.items.length > 1 && (
              <ul className="text-sm text-muted">
                {f.items.map((i) => <li key={i.itemId} className="flex justify-between gap-2"><span>{i.name}{i.qty > 1 ? ` × ${i.qty}` : ""}</span><span>{i.price !== null ? money(i.price * i.qty) : ""}</span></li>)}
              </ul>
            )}
            {f.decision ? (
              <p className={`rounded-lg px-3 py-2.5 text-center font-bold ${f.decision === "approved" ? "bg-[#015d47] text-white" : "bg-[#f3f0ea]"}`}>
                {f.decision === "approved" ? "✓ Yes, fix it" : f.decision === "declined" ? "No, not this time" : "Not answered"}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={`${findingTitle(f.items)}: yes or no`}>
                <label className="cursor-pointer">
                  <input type="radio" name={`d:${f.id}`} value="yes" className="peer sr-only" />
                  <span className="flex min-h-12 items-center justify-center rounded-xl border border-[#cfcbc4] font-bold peer-checked:border-2 peer-checked:border-[#015d47] peer-checked:bg-[#015d47] peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-[#015d47]">Yes, fix it</span>
                </label>
                <label className="cursor-pointer">
                  <input type="radio" name={`d:${f.id}`} value="no" className="peer sr-only" />
                  <span className="flex min-h-12 items-center justify-center rounded-xl border border-[#cfcbc4] font-bold peer-checked:border-2 peer-checked:border-[#17181a] peer-checked:bg-[#f3f0ea] peer-focus-visible:ring-2 peer-focus-visible:ring-[#17181a]">No</span>
                </label>
              </div>
            )}
          </article>
        ))}
        {open.length > 0 && (
          <>
            <button type="submit" className="mt-1 min-h-14 rounded-xl bg-[#17181a] text-lg font-extrabold text-white">Confirm</button>
            <p className="text-center text-sm text-muted">Prices are before tax. You pay when you pick up.{showroom.phone ? ` Questions? Call ${showroom.phone}.` : ""}</p>
          </>
        )}
      </form>
    </Shell>
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
      <main className="mx-auto w-full max-w-md flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
