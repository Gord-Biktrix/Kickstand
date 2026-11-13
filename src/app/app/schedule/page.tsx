import Link from "next/link";
import { db } from "@/db/client";
import { StatusBadge } from "@/components/status-badge";
import { Badge, Card, PageHeader } from "@/components/ui";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { weekSchedule, type ScheduleDay, type ScheduleRow } from "@/lib/queries";
import { addLocalDays, formatLongDateFromLocal, formatShortDateFromLocal, formatTime, localToUtc, minutesToTime, timeToMinutes, toLocalDate, weekdayOf } from "@/lib/time";
import { formatInTimeZone } from "date-fns-tz";
import { listBookings, type BookingRow } from "@/lib/type-bookings";
import { colorOf, effectiveHours, listBookingTypes, type WeeklyHours } from "@/lib/booking-types";
import { parseISO, format } from "date-fns";

export const metadata = { title: "Appointments" };

type View = "day" | "week" | "month";
type Mode = "pickups" | "builds";
type Visit = { key: string; rows: ScheduleRow[]; startsAt: Date; endsAt: Date; customer: string };

function mondayOf(date: string) {
  return addLocalDays(date, -((weekdayOf(date) + 6) % 7));
}
function monthOf(date: string) {
  return date.slice(0, 7);
}
function addMonths(date: string, n: number) {
  const d = parseISO(date);
  d.setMonth(d.getMonth() + n, 1);
  return format(d, "yyyy-MM-dd");
}

/** One block per visit: bikes collected together share a group id. */
function visitsOf(day: ScheduleDay): Visit[] {
  const out: Visit[] = [];
  for (const r of day.pickups) {
    const key = r.appointment.groupId ?? r.appointment.id;
    const v = out.find((x) => x.key === key);
    if (v) v.rows.push(r);
    else out.push({ key, rows: [r], startsAt: r.appointment.startsAt, endsAt: r.appointment.endsAt, customer: r.order?.customerName ?? "Unassigned" });
  }
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** Builds due on a day, as blocks at their build-by time. Date-only deadlines (pickup mode) sit at closing time. */
function buildBlocksOf(day: ScheduleDay, tz: string): Visit[] {
  return day.builds.map((r) => {
    const at = r.buildAt ?? localToUtc(day.date, day.windowEnd, tz);
    return { key: `b-${r.appointment.id}`, rows: [r], startsAt: new Date(at.getTime() - 45 * 60_000), endsAt: at, customer: r.order?.customerName ?? "Unassigned" };
  }).sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime());
}

const buildTone = (rows: ScheduleRow[], now: Date) => {
  const r = rows[0];
  if (r.unit.status === "ready") return "bg-ok-soft border-ok/40";
  if (r.unit.status === "building") return "bg-warn-soft border-warn/40";
  return r.buildAt && r.buildAt < now ? "bg-danger-soft border-danger/40" : "bg-card border-border";
};

const tone = (rows: ScheduleRow[]) => {
  const s = rows.map((r) => r.unit.status);
  if (s.every((x) => x === "ready")) return "bg-ok-soft border-ok/40";
  if (s.some((x) => x === "building")) return "bg-warn-soft border-warn/40";
  return "bg-accent-soft border-accent/40";
};

export default async function SchedulePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const showroom = await currentShowroom();
  const tz = showroom.timezone;
  const now = new Date();
  const today = toLocalDate(now, tz);
  const raw = sp(q.view);
  const view: View = raw === "day" || raw === "month" ? raw : "week";
  // What the blocks represent: customer pickups (slot time) or mechanic builds (build-by time).
  const mode: Mode = sp(q.mode) === "builds" ? "builds" : "pickups";
  const dateParam = sp(q.date) ?? sp(q.week);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateParam ?? "") ? dateParam! : today;

  // Visible range per view. Month shows whole weeks (Mon–Sun) so the grid is rectangular.
  let from: string, to: string, title: string, prev: string, next: string;
  if (view === "day") {
    from = to = date; title = formatLongDateFromLocal(date); prev = addLocalDays(date, -1); next = addLocalDays(date, 1);
  } else if (view === "week") {
    from = mondayOf(date); to = addLocalDays(from, 6); title = `Week of ${formatShortDateFromLocal(from)}`; prev = addLocalDays(from, -7); next = addLocalDays(from, 7);
  } else {
    const first = `${monthOf(date)}-01`;
    from = mondayOf(first);
    const lastOfMonth = addLocalDays(addMonths(first, 1), -1);
    to = addLocalDays(mondayOf(lastOfMonth), 6);
    title = format(parseISO(first), "MMMM yyyy"); prev = addMonths(first, -1); next = addMonths(first, 1);
  }
  const [days, bookingRows, types] = await Promise.all([weekSchedule(db, showroom, from, to), listBookings(db, showroom.id, from, to), listBookingTypes(db, showroom.id)]);
  // Bookings of booking types (test rides, service, calls…) sit beside pickups in "Customers" mode.
  const bookingsOn = (d: string): BookingRow[] => (mode === "pickups" ? bookingRows.filter((r) => r.booking.onDate === d) : []);
  const online = showroom.kind === "online";
  // The online team has no pickup hours: its days are only "closed" when nothing is booked.
  const isClosed = (d: ScheduleDay) => (online ? false : d.closed && bookingsOn(d.date).length === 0);
  const href = (d: string, v: View = view, m: Mode = mode) => `/app/schedule?view=${v}&mode=${m}&date=${d}`;
  const inScope = days.filter((d) => view !== "month" || monthOf(d.date) === monthOf(date));
  const totalPickups = inScope.reduce((n, d) => n + visitsOf(d).length, 0);
  const totalBookings = inScope.reduce((n, d) => n + bookingsOn(d.date).length, 0);
  const totalBuilds = inScope.reduce((n, d) => n + d.builds.length, 0);

  // Time grid bounds: earliest opening to latest close across the visible open days.
  const open = online ? [] : days.filter((d) => !d.closed);
  const bookingMins = (mode === "pickups" ? bookingRows : []).flatMap((r) => [timeToMinutes(formatInTimeZone(r.booking.startsAt, tz, "HH:mm")), timeToMinutes(formatInTimeZone(r.booking.endsAt, tz, "HH:mm"))]);
  // Booking types' own hours widen the grid too (the online team has no pickup hours at all).
  const typeRanges = mode === "pickups" ? types.filter((t) => t.kind === "standard" && t.active).flatMap((t) => Object.values(effectiveHours(t, showroom.bookingHours as WeeklyHours)).flat()) : [];
  const starts = [...open.map((d) => timeToMinutes(d.windowStart)), ...bookingMins, ...typeRanges.map(([a]) => timeToMinutes(a))];
  const ends = [...open.map((d) => timeToMinutes(d.windowEnd)), ...bookingMins, ...typeRanges.map(([, b]) => timeToMinutes(b))];
  const gridStart = Math.floor(Math.min(...(starts.length ? starts : [online ? 480 : 600])) / 60) * 60;
  const gridEnd = Math.max(...(ends.length ? ends : [online ? 960 : 1035]), gridStart + 60);
  const span = gridEnd - gridStart;
  const hours: number[] = [];
  for (let m = Math.floor(gridStart / 60) * 60; m <= gridEnd; m += 60) hours.push(m);
  const pxPerHour = 64;
  const gridHeight = (span / 60) * pxPerHour;
  const yOf = (instant: Date) => ((timeToMinutes(formatInTimeZone(instant, tz, "HH:mm")) - gridStart) / span) * gridHeight;

  // Render helpers (plain functions, not components — see react-hooks/static-components).
  const blocksOf = (d: ScheduleDay) => (mode === "builds" ? buildBlocksOf(d, tz) : visitsOf(d));
  const visitBlock = (v: Visit, compact = false, half = false) => {
    const rawTop = yOf(v.startsAt);
    const top = Math.max(0, Math.min(rawTop, gridHeight - 28));
    const height = Math.max(28, Math.min(yOf(v.endsAt), gridHeight) - top);
    const first = v.rows[0];
    const isBuild = mode === "builds";
    return (
      <Link
        href={`/app/units/${first.unit.id}`}
        className={`absolute left-1 ${half ? "right-[50%]" : "right-1"} overflow-hidden rounded-md border px-2 py-1 text-xs leading-tight shadow-sm hover:ring-2 hover:ring-accent ${isBuild ? buildTone(v.rows, now) : tone(v.rows)}`}
        style={{ top, height }}
        title={isBuild ? `Build by ${formatTime(v.endsAt, tz)} · ${first.unit.model} · box ${first.unit.boxTag} · pickup ${formatShortDateFromLocal(first.appointment.onDate)} ${formatTime(first.appointment.startsAt, tz)}` : `${formatTime(v.startsAt, tz)} · ${v.customer} · ${v.rows.map((r) => r.unit.model).join(", ")}`}
      >
        {isBuild ? (
          <>
            <span className="font-semibold">by {formatTime(v.endsAt, tz)}</span>{" "}
            <span className="font-medium">{first.unit.model}</span>
            {!compact && height >= 44 && <div className="truncate text-muted">box {first.unit.boxTag} · {v.customer} · pickup {formatShortDateFromLocal(first.appointment.onDate)} {formatTime(first.appointment.startsAt, tz)}</div>}
          </>
        ) : (
          <>
            <span className="font-semibold">{formatTime(v.startsAt, tz)}</span>{" "}
            <span className="font-medium">{v.customer}</span>
            {v.rows.length > 1 && <span className="ml-1 rounded bg-white/70 px-1 text-[10px] font-semibold">{v.rows.length} bikes</span>}
            {!compact && height >= 44 && <div className="truncate text-muted">{v.rows.map((r) => r.unit.model).join(", ")}</div>}
          </>
        )}
      </Link>
    );
  };

  const bookingTone = (r: BookingRow) => (r.booking.status === "completed" ? "bg-ok-soft border-ok/40" : r.booking.status === "no_show" ? "bg-danger-soft border-danger/40" : "bg-card border-accent/60");
  const bookingBlock = (r: BookingRow, compact = false, half = false) => {
    const rawTop = yOf(r.booking.startsAt);
    const top = Math.max(0, Math.min(rawTop, gridHeight - 28));
    const height = Math.max(28, Math.min(yOf(r.booking.endsAt), gridHeight) - top);
    return (
      <Link
        key={r.booking.id}
        href={`/app/bookings/${r.booking.id}`}
        className={`absolute ${half ? "left-[50%]" : "left-1"} right-1 overflow-hidden rounded-md border border-dashed px-2 py-1 text-xs leading-tight shadow-sm hover:ring-2 hover:ring-accent ${bookingTone(r)}`}
        style={{ top, height, borderLeft: `4px solid ${colorOf(r.type.color).hex}` }}
        title={`${formatTime(r.booking.startsAt, tz)} · ${r.booking.customerName} · ${r.type.name}`}
      >
        <span className="font-semibold">{formatTime(r.booking.startsAt, tz)}</span> <span className="font-medium">{r.booking.customerName}</span>
        {!compact && height >= 44 ? <div className="truncate text-muted">{r.type.name}</div> : <span className="text-muted"> · {r.type.name}</span>}
      </Link>
    );
  };

  const timeGrid = (cols: ScheduleDay[]) => (
    <div className="overflow-x-auto">
      <div className="grid" style={{ gridTemplateColumns: `56px repeat(${cols.length}, minmax(${cols.length === 1 ? "320px" : "140px"}, 1fr))` }}>
        {/* header row */}
        <div />
        {cols.map((d) => {
          const n = visitsOf(d).length;
          const nb = bookingsOn(d.date).length;
          const isToday = d.date === today;
          return (
            <div key={d.date} className={`border-b border-border px-2 pb-2 text-center ${isClosed(d) ? "text-muted" : ""}`}>
              <Link href={href(d.date, "day")} className={`block text-sm font-semibold ${isToday ? "text-accent" : ""}`}>{cols.length === 1 ? formatLongDateFromLocal(d.date) : formatShortDateFromLocal(d.date)}</Link>
              <div className="mt-0.5 flex items-center justify-center gap-2 text-xs text-muted">
                {isClosed(d) ? <span>closed</span> : online ? <span>{nb} booked</span> : <Link href={`/app/bikes?filter=booked&date=${d.date}`} className="hover:text-accent" title="This day's pickups on Bikes">{n}/{d.capacity} pickups</Link>}
                {!online && nb > 0 && <span className="rounded bg-accent-soft px-1.5 text-accent">{nb} booking{nb === 1 ? "" : "s"}</span>}
                {d.builds.length > 0 && <span title={d.builds.map((b) => `${b.buildAt ? formatTime(b.buildAt, tz) : "EOD"} ${b.unit.model} (${b.order?.customerName ?? "—"})`).join("\n")} className="rounded bg-warn-soft px-1.5 text-warn">{d.builds.length} build{d.builds.length === 1 ? "" : "s"} due</span>}
              </div>
            </div>
          );
        })}
        {/* time labels */}
        <div className="relative" style={{ height: gridHeight }}>
          {hours.map((m) => (
            <div key={m} className="absolute right-2 -translate-y-1/2 text-[11px] text-muted" style={{ top: ((m - gridStart) / span) * gridHeight }}>{minutesToTime(m).replace(/^0/, "")}</div>
          ))}
        </div>
        {cols.map((d) => (
          <div key={d.date} className={`relative border-l border-border ${isClosed(d) ? "bg-neutral-100/60" : d.date < today ? "bg-neutral-50" : ""} ${d.date === today ? "ring-1 ring-inset ring-accent/40" : ""}`} style={{ height: gridHeight }}>
            {hours.map((m) => <div key={m} className="absolute left-0 right-0 border-t border-border/70" style={{ top: ((m - gridStart) / span) * gridHeight }} />)}
            {!d.closed && !online && (
              <>
                <div className="absolute left-0 right-0 bg-neutral-200/40" style={{ top: 0, height: Math.max(0, ((timeToMinutes(d.windowStart) - gridStart) / span) * gridHeight) }} />
                <div className="absolute left-0 right-0 bg-neutral-200/40" style={{ top: ((timeToMinutes(d.windowEnd) - gridStart) / span) * gridHeight, bottom: 0 }} />
              </>
            )}
            {d.date === today && now.getTime() >= 0 && (() => { const y = yOf(now); return y >= 0 && y <= gridHeight ? <div className="absolute left-0 right-0 z-10 border-t-2 border-danger" style={{ top: y }} /> : null; })()}
            {(() => {
              const bks = bookingsOn(d.date);
              const blocks = blocksOf(d);
              const half = bks.length > 0 && blocks.length > 0;
              return (
                <>
                  {blocks.map((v) => <div key={v.key}>{visitBlock(v, cols.length > 1, half)}</div>)}
                  {bks.map((r) => bookingBlock(r, cols.length > 1, half))}
                </>
              );
            })()}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Appointments"
        subtitle={`${title} · ${mode === "builds" ? `${totalBuilds} build${totalBuilds === 1 ? "" : "s"} due` : [online ? "" : `${totalPickups} pickup${totalPickups === 1 ? "" : "s"}`, `${totalBookings} booking${totalBookings === 1 ? "" : "s"}`].filter(Boolean).join(" · ")} · ${showroom.name}`}
        action={
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Link className="btn btn-primary btn-sm" href="/app/bookings/new">+ Book</Link>
            {!online && (
              <div className="flex rounded-lg border border-border bg-card p-0.5" role="tablist" aria-label="Who is this for">
                <Link role="tab" aria-selected={mode === "pickups"} href={href(date, view, "pickups")} className={`rounded-md px-3 py-1 ${mode === "pickups" ? "bg-accent text-white" : "hover:text-accent"}`}>Customers</Link>
                <Link role="tab" aria-selected={mode === "builds"} href={href(date, view, "builds")} className={`rounded-md px-3 py-1 ${mode === "builds" ? "bg-accent text-white" : "hover:text-accent"}`}>Mechanic builds</Link>
              </div>
            )}
            <div className="flex rounded-lg border border-border bg-card p-0.5" role="tablist" aria-label="View">
              {(["day", "week", "month"] as View[]).map((v) => (
                <Link key={v} role="tab" aria-selected={view === v} href={href(view === "week" && v !== "week" ? date : date, v)} className={`rounded-md px-3 py-1 capitalize ${view === v ? "bg-accent text-white" : "hover:text-accent"}`}>{v}</Link>
              ))}
            </div>
            <Link className="btn btn-sm" href={href(prev)} aria-label="Previous">←</Link>
            <Link className="btn btn-sm" href={href(today)}>Today</Link>
            <Link className="btn btn-sm" href={href(next)} aria-label="Next">→</Link>
          </div>
        }
      />

      {view === "month" ? (
        <div className="overflow-x-auto">
          <div className="grid min-w-[840px] grid-cols-7 gap-px rounded-lg border border-border bg-border">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((w) => <div key={w} className="bg-card px-2 py-1 text-center text-xs font-semibold text-muted">{w}</div>)}
            {days.map((d) => {
              const visits = visitsOf(d);
              const inMonth = monthOf(d.date) === monthOf(date);
              const isToday = d.date === today;
              return (
                <div key={d.date} className={`min-h-[112px] bg-card p-1.5 ${!inMonth ? "opacity-40" : ""} ${isClosed(d) ? "bg-neutral-50" : ""}`}>
                  <div className="mb-1 flex items-baseline justify-between">
                    <Link href={href(d.date, "day")} className={`text-sm font-semibold ${isToday ? "rounded-full bg-accent px-1.5 text-white" : ""}`}>{d.date.slice(8).replace(/^0/, "")}</Link>
                    <span className="text-[10px] text-muted">{isClosed(d) ? "closed" : online ? `${bookingsOn(d.date).length} booked` : `${visits.length}/${d.capacity}`}</span>
                  </div>
                  <ul className="space-y-0.5">
                    {mode === "builds" ? (
                      <>
                        {buildBlocksOf(d, tz).slice(0, 3).map((v) => (
                          <li key={v.key}>
                            <Link href={`/app/units/${v.rows[0].unit.id}`} className={`block truncate rounded border px-1 text-[11px] leading-5 ${buildTone(v.rows, now)}`} title={`${v.rows[0].unit.model} · box ${v.rows[0].unit.boxTag}`}>
                              <span className="font-semibold">by {formatTime(v.endsAt, tz).replace(" ", "")}</span> {v.rows[0].unit.model}
                            </Link>
                          </li>
                        ))}
                        {d.builds.length > 3 && <li><Link href={href(d.date, "day")} className="text-[11px] text-muted hover:text-accent">+{d.builds.length - 3} more</Link></li>}
                      </>
                    ) : visits.slice(0, 3).map((v) => (
                      <li key={v.key}>
                        <Link href={`/app/units/${v.rows[0].unit.id}`} className={`block truncate rounded border px-1 text-[11px] leading-5 ${tone(v.rows)}`} title={v.rows.map((r) => r.unit.model).join(", ")}>
                          <span className="font-semibold">{formatTime(v.startsAt, tz).replace(" ", "")}</span> {v.customer}{v.rows.length > 1 && ` (${v.rows.length})`}
                        </Link>
                      </li>
                    ))}
                    {mode === "pickups" && visits.length > 3 && <li><Link href={href(d.date, "day")} className="text-[11px] text-muted hover:text-accent">+{visits.length - 3} more</Link></li>}
                    {bookingsOn(d.date).slice(0, 3).map((r) => (
                      <li key={r.booking.id}>
                        <Link href={`/app/bookings/${r.booking.id}`} className={`block truncate rounded border border-dashed px-1 text-[11px] leading-5 ${bookingTone(r)}`} style={{ borderLeft: `3px solid ${colorOf(r.type.color).hex}` }} title={r.type.name}>
                          <span className="font-semibold">{formatTime(r.booking.startsAt, tz).replace(" ", "")}</span> {r.booking.customerName}
                        </Link>
                      </li>
                    ))}
                    {bookingsOn(d.date).length > 3 && <li><Link href={href(d.date, "day")} className="text-[11px] text-muted hover:text-accent">+{bookingsOn(d.date).length - 3} more bookings</Link></li>}
                    {mode === "pickups" && d.builds.length > 0 && <li className="text-[10px] text-warn">{d.builds.length} build{d.builds.length === 1 ? "" : "s"} due</li>}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      ) : view === "week" ? (
        timeGrid(days)
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          {timeGrid(days)}
          <div className="space-y-4">
            {mode === "pickups" && (
              <Card title={`Bookings (${bookingsOn(days[0].date).length})`}>
                {bookingsOn(days[0].date).length === 0 ? <p className="text-sm text-muted">No bookings.</p> : (
                  <ul className="divide-y divide-border text-sm">
                    {bookingsOn(days[0].date).map((r) => (
                      <li key={r.booking.id} className="py-2">
                        <Link href={`/app/bookings/${r.booking.id}`} className="font-medium hover:text-accent">{formatTime(r.booking.startsAt, tz)} · {r.booking.customerName}</Link>
                        <p className="text-xs text-muted">{r.type.name}{r.booking.status !== "booked" ? ` · ${r.booking.status === "completed" ? "checked in" : "no-show"}` : ""}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
            {!online && <Card title={`Pickups (${visitsOf(days[0]).length})`}>
              {visitsOf(days[0]).length === 0 ? <p className="text-sm text-muted">{days[0].closed ? "Closed." : "No pickups booked."}</p> : (
                <ul className="divide-y divide-border text-sm">
                  {visitsOf(days[0]).map((v) => (
                    <li key={v.key} className="py-2">
                      <p className="font-medium">{formatTime(v.startsAt, tz)} · {v.customer}{v.rows.length > 1 && <Badge tone="accent">{v.rows.length} bikes</Badge>}</p>
                      {v.rows.map((r) => (
                        <p key={r.unit.id} className="flex items-center justify-between gap-2 text-xs text-muted"><Link href={`/app/units/${r.unit.id}`} className="hover:text-accent">{r.unit.model} · box {r.unit.boxTag}</Link><StatusBadge status={r.unit.status} /></p>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
            </Card>}
            {!online && <Card title={`Builds due (${days[0].builds.length})`}>
              {days[0].builds.length === 0 ? <p className="text-sm text-muted">Nothing due today.</p> : (
                <ul className="divide-y divide-border text-sm">
                  {days[0].builds.map((r) => {
                    const overdue = r.unit.status === "booked" && (r.buildAt ? r.buildAt < now : false);
                    return (
                      <li key={r.appointment.id} className="flex items-center justify-between gap-2 py-2">
                        <span><span className="font-semibold">{r.buildAt ? `by ${formatTime(r.buildAt, tz)}` : "by end of day"}</span> · <Link href={`/app/units/${r.unit.id}`} className="hover:text-accent">{r.unit.model}</Link> <span className="text-xs text-muted">box {r.unit.boxTag} · pickup {formatShortDateFromLocal(r.appointment.onDate)} {formatTime(r.appointment.startsAt, tz)}</span></span>
                        <span className="flex gap-1"><StatusBadge status={r.unit.status} />{overdue && <Badge tone="danger">overdue</Badge>}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>}
          </div>
        </div>
      )}
      <p className="mt-3 text-xs text-muted">{mode === "builds" ? "Blocks end at each bike's build-by time (8 working hours before its pickup). Red = overdue, orange = building, green = ready." : "Solid blocks are pickup visits (several bikes collected together are one block); dashed blocks are bookings such as test rides, service and calls."} Shaded time is outside opening hours. Click a day to open it.</p>
    </div>
  );
}
