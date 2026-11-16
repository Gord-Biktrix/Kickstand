import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "@/db/client";
import { lsEmployees } from "@/db/schema";
import { Flash } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { LightspeedClient, lightspeedEnabled } from "@/lib/lightspeed";
import { SERVICE_MENU, searchCustomers } from "@/lib/tickets";
import { createTicketAction } from "../../actions";

export const metadata = { title: "New ticket" };

const label = "text-[11px] font-extrabold tracking-wider text-[#3d3f43] uppercase";

/**
 * New ticket in the POS layout: the ticket on the left like a cart (who, which bike, what they said, when it's
 * ready, one big Create button), the service menu as tiles on the right. "Find" re-loads the page with what's
 * typed so far (a GET of the same form), so nothing is lost while searching for the customer.
 */
export default async function NewTicketPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  await requireUser("staff");
  const showroom = await currentShowroom();
  const tz = showroom.timezone;
  const v = (k: string) => sp(q[k]) ?? "";
  const query = v("q");
  const ls = lightspeedEnabled(showroom);
  const search = query ? await searchCustomers(db, query, ls ? new LightspeedClient(db) : undefined) : { matches: [], lightspeedFailed: false };
  const employees = await db.select().from(lsEmployees).orderBy(lsEmployees.name);
  const service = v("service");
  const minutes = SERVICE_MENU.find((s) => s.name === service)?.minutes ?? showroom.settings.repair_minutes;
  // Ready by: now + the job's time, rounded up to the next quarter hour, in the store's time.
  const readyDefault = quarterHourAfter(new Date(), minutes);
  const ready = v("ready") || formatInTimeZone(readyDefault, tz, "yyyy-MM-dd'T'HH:mm");
  const picked = v("c");

  return (
    <div>
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Link href="/app/workshop" className="text-sm underline">← Workshop</Link>
        {!ls && <p className="text-sm text-red-700">Lightspeed isn&apos;t switched on for this store, so tickets can&apos;t be created here.</p>}
      </div>

      <form action={createTicketAction} className="grid gap-4 lg:grid-cols-[420px_minmax(0,1fr)]">
        <section aria-label="New ticket" className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border p-4">
            <h1 className="text-xl font-extrabold">New ticket</h1>
            <p className="text-sm text-muted">Walk-in or phone-in repair · {showroom.name}</p>
          </div>

          <div className="flex flex-col gap-4 p-4">
            <fieldset className="flex min-w-0 flex-col gap-2">
              <legend className={label}>Customer</legend>
              <div className="flex gap-2">
                <label htmlFor="q" className="sr-only">Find a customer by name, phone or email</label>
                <input id="q" name="q" defaultValue={query} placeholder="Name, phone or email" className="input h-12 min-w-0 flex-1 text-base" autoComplete="off" />
                <button type="submit" formAction="/app/workshop/new" formMethod="get" className="btn min-h-12">Find</button>
              </div>
              {query && search.matches.length === 0 && <p className="text-sm text-muted">No one found for &ldquo;{query}&rdquo;. Add them below.</p>}
              {search.lightspeedFailed && <p className="text-xs text-muted">Lightspeed&apos;s customer list didn&apos;t answer; showing Kickstand&apos;s customers only.</p>}
              {search.matches.map((m, i) => {
                const value = [m.lsCustomerId ?? "", m.name, m.phone ?? "", m.email ?? ""].join("|");
                return (
                  <label key={m.key} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 has-[:checked]:border-2 has-[:checked]:border-[#17181a] has-[:checked]:bg-[#f7f6f3]">
                    <input type="radio" name="c" value={value} defaultChecked={picked ? picked === value : i === 0} className="h-5 w-5" />
                    <span className="min-w-0">
                      <span className="block font-semibold">{m.name}</span>
                      <span className="block truncate text-xs text-muted">{[m.phone, m.email, m.source].filter(Boolean).join(" · ")}</span>
                    </span>
                  </label>
                );
              })}
              <details open={!query || search.matches.length === 0} className="rounded-lg border border-border px-3 py-2">
                <summary className="min-h-8 cursor-pointer text-sm font-semibold">New customer</summary>
                <label className="mt-2 flex min-h-11 items-center gap-2 text-sm">
                  <input type="radio" name="c" value="new" defaultChecked={!query || search.matches.length === 0 || picked === "new"} className="h-5 w-5" /> Use these details
                </label>
                <div className="mt-1 grid gap-2">
                  <input name="nn" defaultValue={v("nn")} placeholder="Full name" aria-label="Customer's full name" className="input h-11 text-base" />
                  <input name="np" defaultValue={v("np")} placeholder="Mobile" inputMode="tel" aria-label="Customer's mobile" className="input h-11 text-base" />
                  <input name="ne" defaultValue={v("ne")} placeholder="Email (optional)" inputMode="email" aria-label="Customer's email" className="input h-11 text-base" />
                </div>
              </details>
            </fieldset>

            <div className="grid gap-2">
              <label htmlFor="bike" className={label}>Bike</label>
              <input id="bike" name="bike" defaultValue={v("bike")} placeholder="e.g. Stunner Lite 3, peach" className="input h-11 text-base" />
              <input name="serial" defaultValue={v("serial")} placeholder="Serial (optional)" aria-label="Serial number" className="input h-11 text-base" />
            </div>

            <div className="grid gap-2">
              <label htmlFor="said" className={label}>What they say</label>
              <textarea id="said" name="said" defaultValue={v("said")} rows={3} placeholder="In their words" className="input min-h-20 py-2 text-base" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1">
                <label htmlFor="ready" className={label}>Ready by</label>
                <input id="ready" name="ready" type="datetime-local" defaultValue={ready} className="input h-11 text-base" />
              </div>
              <div className="grid gap-1">
                <label htmlFor="mech" className={label}>Mechanic</label>
                <select id="mech" name="mech" defaultValue={v("mech")} className="input h-11 text-base">
                  <option value="">Not assigned</option>
                  {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </div>
            </div>
          </div>

          <div className="mt-auto border-t border-border p-4">
            <button type="submit" disabled={!ls} className="flex min-h-16 w-full items-center justify-center rounded-xl bg-[#ff6b1a] text-lg font-extrabold text-[#17181a] disabled:opacity-50">Create ticket</button>
            <p className="mt-2 text-xs text-muted">Creates the Lightspeed work order (Open, date in now) and puts it in To do on the board.</p>
          </div>
        </section>

        <section aria-labelledby="needs" className="flex min-w-0 flex-col gap-3">
          <h2 id="needs" className={label}>What does it need?</h2>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
            {SERVICE_MENU.map((s) => (
              <label key={s.key} className="flex min-h-24 cursor-pointer flex-col justify-between rounded-xl border border-border bg-card p-3 has-[:checked]:border-2 has-[:checked]:border-[#17181a] has-[:checked]:bg-[#f7f6f3]">
                <input type="radio" name="service" value={s.name} defaultChecked={service === s.name} className="sr-only" />
                <span className="font-bold">{s.name}</span>
                <span className="text-sm text-muted">about {s.minutes < 60 ? `${s.minutes} min` : `${s.minutes / 60} h`}</span>
              </label>
            ))}
          </div>
          <p className="text-sm text-muted">The service goes on the work order&apos;s note and Hook In. Its parts and labour lines (with Lightspeed prices) come next, after a test on a real work order; add them in Lightspeed for now.</p>
        </section>
      </form>
    </div>
  );
}

/** now + minutes, rounded up to the next quarter hour. */
function quarterHourAfter(now: Date, minutes: number): Date {
  return new Date(Math.ceil((now.getTime() + minutes * 60_000) / 900_000) * 900_000);
}
