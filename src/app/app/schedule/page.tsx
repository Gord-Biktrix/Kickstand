import Link from "next/link";
import { db } from "@/db/client";
import { StatusBadge } from "@/components/status-badge";
import { Badge, Card, PageHeader } from "@/components/ui";
import { sp, type SearchParams } from "@/lib/flash";
import { weekSchedule, type ScheduleRow } from "@/lib/queries";
import { getShowroom } from "@/lib/showroom";
import { addLocalDays, formatShortDateFromLocal, formatTime, toLocalDate, weekdayOf } from "@/lib/time";

export const metadata = { title: "Schedule" };

type View = "pickups" | "builds";

function mondayOf(date: string) {
  return addLocalDays(date, -((weekdayOf(date) + 6) % 7));
}

function PickupCard({ r, tz }: { r: ScheduleRow; tz: string }) {
  return (
    <li className="rounded-md border border-border bg-card p-2 text-xs">
      <p className="font-semibold">{formatTime(r.appointment.startsAt, tz)}</p>
      <p className="truncate font-medium"><Link href={`/app/units/${r.unit.id}`} className="hover:text-accent">{r.order?.customerName ?? "Unassigned"}</Link></p>
      <p className="truncate text-muted">{r.unit.model}</p>
      <div className="mt-1"><StatusBadge status={r.unit.status} /></div>
    </li>
  );
}

function BuildCard({ r, tz, now }: { r: ScheduleRow; tz: string; now: Date }) {
  const overdue = r.unit.status === "booked" && (r.buildAt ? r.buildAt < now : false);
  return (
    <li className={`rounded-md border p-2 text-xs ${overdue ? "border-danger/40 bg-danger-soft" : r.unit.status === "booked" ? "border-warn/40 bg-warn-soft" : "border-border bg-card"}`}>
      <p className="font-semibold">{r.buildAt ? `by ${formatTime(r.buildAt, tz)}` : "by end of day"}</p>
      <p className="truncate font-medium"><Link href={`/app/units/${r.unit.id}`} className="hover:text-accent">{r.unit.model}</Link></p>
      <p className="truncate text-muted">box {r.unit.boxTag} · pickup {formatShortDateFromLocal(r.appointment.onDate)} {formatTime(r.appointment.startsAt, tz)}</p>
      <div className="mt-1 flex flex-wrap gap-1"><StatusBadge status={r.unit.status} />{overdue && <Badge tone="danger">overdue</Badge>}</div>
    </li>
  );
}

export default async function SchedulePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const showroom = await getShowroom(db);
  const tz = showroom.timezone;
  const now = new Date();
  const today = toLocalDate(now, tz);
  const view: View = sp(q.view) === "builds" ? "builds" : "pickups";
  const weekParam = sp(q.week);
  const monday = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(weekParam ?? "") ? weekParam! : today);
  const sunday = addLocalDays(monday, 6);
  const days = await weekSchedule(db, showroom, monday, sunday);
  const total = days.reduce((n, d) => n + (view === "pickups" ? d.pickups.length : d.builds.length), 0);
  const href = (w: string, v: View = view) => `/app/schedule?view=${v}&week=${w}`;
  const dueTime = showroom.settings.lightspeed.due_mode === "assembly" ? showroom.settings.lightspeed.assembly_due_time_local : null;

  return (
    <div>
      <PageHeader
        title="Schedule"
        subtitle={`Week of ${formatShortDateFromLocal(monday)} · ${total} ${view === "pickups" ? "pickup" : "build"}${total === 1 ? "" : "s"} · ${showroom.name}`}
        action={
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <div className="flex rounded-lg border border-border bg-card p-0.5" role="tablist" aria-label="View">
              <Link role="tab" aria-selected={view === "pickups"} href={href(monday, "pickups")} className={`rounded-md px-3 py-1 ${view === "pickups" ? "bg-accent text-white" : "hover:text-accent"}`}>Customer pickups</Link>
              <Link role="tab" aria-selected={view === "builds"} href={href(monday, "builds")} className={`rounded-md px-3 py-1 ${view === "builds" ? "bg-accent text-white" : "hover:text-accent"}`}>Mechanic builds</Link>
            </div>
            <Link className="btn btn-sm" href={href(addLocalDays(monday, -7))}>← Prev</Link>
            <Link className="btn btn-sm" href={href(today)}>This week</Link>
            <Link className="btn btn-sm" href={href(addLocalDays(monday, 7))}>Next →</Link>
          </div>
        }
      />
      <p className="mb-4 text-sm text-muted">
        {view === "pickups"
          ? "When customers are coming in. Each day shows booked against capacity."
          : dueTime
            ? `When each bike must be built: by ${dueTime} on the pickup day, or the previous open day for earlier slots. This is the Due time on the Lightspeed work order.`
            : "When each bike must be built: by the end of the last open day before its pickup."}
      </p>
      <div className="overflow-x-auto">
        <div className="grid min-w-[880px] grid-cols-7 gap-2">
          {days.map((d) => {
            const rows = view === "pickups" ? d.pickups : d.builds;
            const isToday = d.date === today;
            const past = d.date < today;
            return (
              <Card key={d.date} className={`min-h-[180px] !p-2 ${isToday ? "ring-2 ring-accent" : ""} ${d.closed ? "opacity-60" : ""} ${past ? "bg-neutral-50" : ""}`}>
                <div className="mb-2 flex items-baseline justify-between">
                  <Link href={`/app?date=${d.date}`} className={`text-sm font-semibold ${isToday ? "text-accent" : ""}`}>{formatShortDateFromLocal(d.date)}</Link>
                  <span className="text-xs text-muted">
                    {d.closed ? "closed" : view === "pickups" ? `${d.pickups.length}/${d.capacity}` : `${d.builds.length} build${d.builds.length === 1 ? "" : "s"}`}
                  </span>
                </div>
                {rows.length === 0 ? (
                  <p className="text-center text-xs text-muted">{d.closed ? "—" : view === "pickups" ? "No pickups" : "Nothing due"}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {rows.map((r) => (view === "pickups" ? <PickupCard key={r.appointment.id} r={r} tz={tz} /> : <BuildCard key={r.appointment.id} r={r} tz={tz} now={now} />))}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
