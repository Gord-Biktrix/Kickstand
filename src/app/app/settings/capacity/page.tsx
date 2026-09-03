import { db } from "@/db/client";
import { ConfirmButton } from "@/components/confirm-button";
import { Card, Field, Flash, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { effectiveCapacity } from "@/lib/capacity";
import { sp, type SearchParams } from "@/lib/flash";
import { bookedCountsByDate } from "@/lib/queries";
import { getCapacityConfig, getShowroom } from "@/lib/showroom";
import { addLocalDays, dateRange, formatLongDateFromLocal, formatShortDateFromLocal, normalizeTime, toLocalDate } from "@/lib/time";
import { deleteOverrideAction, saveCapacityTemplateAction, upsertOverrideAction } from "../../actions";

export const metadata = { title: "Capacity" };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hhmm = (t: string) => normalizeTime(t).slice(0, 5);

export default async function CapacityPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  await requireUser("manager");
  const showroom = await getShowroom(db);
  const today = toLocalDate(new Date(), showroom.timezone);
  const horizon = addLocalDays(today, 55);
  const { rules, overrides } = await getCapacityConfig(db, showroom.id);
  const upcoming = overrides.filter((o) => o.onDate >= today);
  const booked = await bookedCountsByDate(db, showroom.id, today, horizon);
  const days = dateRange(today, horizon).map((d) => ({ date: d, eff: effectiveCapacity(d, rules, overrides), booked: booked.get(d) ?? 0 }));
  const weeks: (typeof days)[] = [];
  for (const d of days) {
    if (weeks.length === 0 || weeks[weeks.length - 1].length === 7) weeks.push([]);
    weeks[weeks.length - 1].push(d);
  }

  return (
    <div>
      <PageHeader title="Capacity" subtitle="Pickups per day. Changes apply to the customer calendar immediately; existing bookings are never cancelled automatically." />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Weekly template">
          <form action={saveCapacityTemplateAction} className="space-y-3">
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>Day</th><th>Closed</th><th>X</th><th>Window start</th><th>Window end</th><th>Max at once</th></tr></thead>
                <tbody>
                  {WEEKDAYS.map((name, wd) => {
                    const r = rules.find((x) => x.weekday === wd);
                    return (
                      <tr key={wd}>
                        <td className="font-medium">{name}</td>
                        <td><input type="checkbox" name={`closed_${wd}`} defaultChecked={(r?.capacity ?? 0) === 0} aria-label={`${name} closed`} className="h-4 w-4" /></td>
                        <td><input name={`capacity_${wd}`} type="number" min={0} max={50} defaultValue={r?.capacity ?? 0} className="input w-20" aria-label={`${name} capacity`} /></td>
                        <td><input name={`start_${wd}`} type="time" defaultValue={hhmm(r?.windowStart ?? "12:00")} className="input w-32" aria-label={`${name} window start`} /></td>
                        <td><input name={`end_${wd}`} type="time" defaultValue={hhmm(r?.windowEnd ?? "17:15")} className="input w-32" aria-label={`${name} window end`} /></td>
                        <td><input name={`mc_${wd}`} type="number" min={1} max={10} defaultValue={r?.maxConcurrent ?? 1} className="input w-20" aria-label={`${name} max concurrent`} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted">Slots start every {showroom.settings.slot_minutes} minutes inside the window; the last slot must end by the window end.</p>
            <button type="submit" className="btn btn-primary">Save template</button>
          </form>
        </Card>

        <div className="space-y-6">
          <Card title="Add or change a date override">
            <form action={upsertOverrideAction} className="grid gap-3 sm:grid-cols-2">
              <Field label="Date" htmlFor="on_date"><input id="on_date" name="on_date" type="date" required min={today} className="input" /></Field>
              <Field label="X (pickups)" htmlFor="capacity"><input id="capacity" name="capacity" type="number" min={0} max={50} defaultValue={0} className="input" /></Field>
              <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="closed" className="h-4 w-4" /> Closed (X = 0)</label>
              <Field label="Window start (optional)" htmlFor="start"><input id="start" name="start" type="time" className="input" /></Field>
              <Field label="Window end (optional)" htmlFor="end"><input id="end" name="end" type="time" className="input" /></Field>
              <Field label="Max at once (optional)" htmlFor="mc"><input id="mc" name="mc" type="number" min={1} max={10} className="input" /></Field>
              <Field label="Note" htmlFor="note"><input id="note" name="note" className="input" placeholder="Labour Day, container day…" /></Field>
              <div className="sm:col-span-2"><button type="submit" className="btn btn-primary">Save override</button></div>
            </form>
          </Card>
          <Card title={`Upcoming overrides (${upcoming.length})`}>
            {upcoming.length === 0 ? <p className="text-sm text-muted">None.</p> : (
              <ul className="divide-y divide-border text-sm">
                {upcoming.map((o) => (
                  <li key={o.id} className="flex items-center justify-between gap-3 py-2">
                    <span><strong>{formatLongDateFromLocal(o.onDate)}</strong> — {o.capacity === 0 ? "closed" : `X = ${o.capacity}`}{o.windowStart && o.windowEnd ? `, ${hhmm(o.windowStart)}–${hhmm(o.windowEnd)}` : ""}{o.maxConcurrent ? `, ${o.maxConcurrent} at once` : ""}{o.note ? ` · ${o.note}` : ""}</span>
                    <form action={deleteOverrideAction.bind(null, o.id)}><ConfirmButton message={`Remove the override for ${o.onDate}?`}>Remove</ConfirmButton></form>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Card title="Next 8 weeks — booked / X" className="mt-6">
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr>{WEEKDAYS.map((w) => <th key={w}>{w.slice(0, 3)}</th>)}</tr></thead>
            <tbody>
              {weeks.map((week, i) => (
                <tr key={i}>
                  {(() => {
                    const cells = [];
                    const firstDow = new Date(week[0].date + "T00:00:00").getDay();
                    for (let p = 0; p < (i === 0 ? firstDow : 0); p++) cells.push(<td key={`pad-${p}`} />);
                    for (const d of week) {
                      const over = d.booked > d.eff.capacity;
                      cells.push(
                        <td key={d.date} className={`${d.eff.closed ? "text-muted" : ""} ${over ? "bg-danger-soft" : d.eff.overridden ? "bg-warn-soft" : ""}`}>
                          <div className="text-xs">{formatShortDateFromLocal(d.date)}</div>
                          <div className="font-medium">{d.eff.closed ? (d.booked ? `${d.booked} / closed` : "closed") : `${d.booked} / ${d.eff.capacity}`}</div>
                          {d.eff.note && <div className="text-xs text-muted">{d.eff.note}</div>}
                        </td>,
                      );
                    }
                    return cells;
                  })()}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">Amber = override in effect. Red = more bookings than X (see Watchlist → Day-closed conflicts).</p>
      </Card>
    </div>
  );
}
