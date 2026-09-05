import { db } from "@/db/client";
import { Card, Field, PageHeader, Stat } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import { sp, type SearchParams } from "@/lib/flash";
import { pilotMetrics } from "@/lib/queries";
import { addLocalDays, toLocalDate } from "@/lib/time";
import { currentShowroom } from "@/lib/current-showroom";

export const metadata = { title: "Reports" };

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
const fixed = (n: number | null | undefined, digits = 1) => (n == null ? "—" : Number(n).toFixed(digits));

export default async function ReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  await requireUser("admin");
  const showroom = await currentShowroom();
  const today = toLocalDate(new Date(), showroom.timezone);
  const isDate = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const from = isDate(sp(q.from)) ? sp(q.from)! : addLocalDays(today, -30);
  const to = isDate(sp(q.to)) ? sp(q.to)! : today;
  const m = await pilotMetrics(db, showroom, from, to);

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle={`Pilot metrics · ${showroom.name} · ${from} to ${to}`}
        action={
          <form className="flex items-end gap-2">
            <Field label="From" htmlFor="from"><input id="from" name="from" type="date" defaultValue={from} className="input" /></Field>
            <Field label="To" htmlFor="to"><input id="to" name="to" type="date" defaultValue={to} className="input" /></Field>
            <button type="submit" className="btn">Apply</button>
          </form>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Floor-days of built, unclaimed bikes" value={fixed(m.floor?.avg_floor_days)} hint={`avg per unit · target < 2 · ${m.floor?.units ?? 0} units`} />
        <Stat label="Box-days arrival → pickup" value={fixed(m.boxDays?.median_days)} hint={`median · target ≤ 10 · ${m.boxDays?.units ?? 0} units`} />
        <Stat label="Booked within 72 h" value={pct(m.early?.within_72 ?? 0, m.early?.invited ?? 0)} hint={`${m.early?.within_72 ?? 0} of ${m.early?.invited ?? 0} invited · target ≥ 60%`} />
        <Stat label="No-show + late-change rate" value={pct(m.noShow?.no_shows ?? 0, m.noShow?.reached ?? 0)} hint={`${m.noShow?.no_shows ?? 0} of ${m.noShow?.reached ?? 0} reaching their date · target < 5%`} />
        <Stat label="Storage assessed vs waived" value={`${formatMoney(m.storage?.collected ?? 0)} / ${formatMoney(m.storage?.waived ?? 0)}`} hint="collected / waived at handover" />
        <Stat label="Invites sent" value={m.invites?.invites ?? 0} hint="incl. re-assignments" />
        <Stat label="Messages" value={`${m.messages?.sent ?? 0} sent`} hint={`${m.messages?.failed ?? 0} failed · ${pct(m.messages?.failed ?? 0, (m.messages?.sent ?? 0) + (m.messages?.failed ?? 0))} failure rate`} />
        <Stat label="Releases and defers" value={m.detaches.reduce((a, d) => a + d.n, 0)} hint={m.detaches.map((d) => `${d.reason}: ${d.n}${d.avg_hours_to_reassign != null ? ` (${fixed(d.avg_hours_to_reassign / 24)} d to reassign)` : ""}`).join(" · ") || "none"} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Days to fill Saturday">
          {m.saturdays.length === 0 ? <p className="text-sm text-muted">No Saturday bookings in range.</p> : (
            <table className="table">
              <thead><tr><th>Saturday</th><th>Booked</th><th>First → last booking (days)</th></tr></thead>
              <tbody>{m.saturdays.map((s) => <tr key={s.on_date}><td>{s.on_date}</td><td>{s.booked}</td><td>{fixed(s.days_to_fill)}</td></tr>)}</tbody>
            </table>
          )}
        </Card>
        <Card title="Slot utilisation by weekday">
          {m.utilisation.length === 0 ? <p className="text-sm text-muted">No appointments in range.</p> : (
            <table className="table">
              <thead><tr><th>Weekday</th><th>Appointments</th><th>Open days used</th><th>Per day</th></tr></thead>
              <tbody>{m.utilisation.map((u) => <tr key={u.dow}><td>{DOW[u.dow]}</td><td>{u.booked}</td><td>{u.days}</td><td>{fixed(u.booked / Math.max(1, u.days))}</td></tr>)}</tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="Export" className="mt-6">
        <div className="flex flex-wrap gap-2">
          <a className="btn btn-sm" href="/api/reports/export?type=units">Units CSV</a>
          <a className="btn btn-sm" href="/api/reports/export?type=appointments">Appointments CSV</a>
        </div>
      </Card>
    </div>
  );
}
