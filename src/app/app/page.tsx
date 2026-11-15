import { Fragment } from "react";
import Link from "next/link";
import { db } from "@/db/client";
import { StatusBadge } from "@/components/status-badge";
import { Badge, Card, Empty, Flash, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import { sp, type SearchParams } from "@/lib/flash";
import { todayAppointments, weekSchedule } from "@/lib/queries";
import { automationSummary } from "@/lib/day-summary";
import { addLocalDays, formatLongDateFromLocal, formatTime, toLocalDate } from "@/lib/time";
import { collectPartsAction, recordNoShowAction } from "./actions";
import { colorOf, doneWords, LOCATION_LABEL, type BookingLocation } from "@/lib/booking-types";
import { listBookings, type BookingRow } from "@/lib/type-bookings";
import { currentShowroom } from "@/lib/current-showroom";
import { ContactFlag } from "@/components/contact-flag";

export const metadata = { title: { absolute: "Today · Kickstand" } };

export default async function TodayPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  await getCurrentUser();
  const showroom = await currentShowroom();
  const now = new Date();
  const today = toLocalDate(now, showroom.timezone);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp(q.date) ?? "") ? sp(q.date)! : today;
  const store = showroom.kind !== "online";
  const [rows, bookingRows, sched, done] = await Promise.all([
    todayAppointments(db, showroom, date, now),
    listBookings(db, showroom.id, date, date),
    store ? weekSchedule(db, showroom, date, date) : Promise.resolve([]),
    automationSummary(db, showroom, date),
  ]);
  const buildsDue = sched[0]?.builds ?? [];
  // One card per visit: bikes collected together share a group id.
  const visits: (typeof rows)[] = [];
  for (const r of rows) {
    const g = r.appointment.groupId;
    const existing = g ? visits.find((v) => v[0].appointment.groupId === g) : undefined;
    if (existing) existing.push(r);
    else visits.push([r]);
  }
  const denied = sp(q.denied) === "1";
  // Pickups and bookings (test rides, service, calls…) in one list, by start time.
  const allItems: ({ kind: "visit"; at: number; visit: (typeof rows) } | { kind: "booking"; at: number; row: BookingRow })[] = [
    ...visits.map((visit) => ({ kind: "visit" as const, at: visit[0].appointment.startsAt.getTime(), visit })),
    ...bookingRows.map((row) => ({ kind: "booking" as const, at: row.booking.startsAt.getTime(), row })),
  ].sort((a, b) => a.at - b.at);
  // Filter chips by visit type: pickups, then each booking type that has visits this day.
  const filter = sp(q.type) ?? "";
  const typeChips = [...new Map(bookingRows.map((r) => [r.type.id, r.type])).values()];
  const items = allItems.filter((i) => !filter || (filter === "pickups" ? i.kind === "visit" : i.kind === "booking" && i.row.type.id === filter));
  const chipHref = (t: string) => `/app?${new URLSearchParams({ ...(date !== today ? { date } : {}), ...(t ? { type: t } : {}) }).toString()}`;
  const counts = [
    rows.length ? `${rows.length} pickup${rows.length === 1 ? "" : "s"}` : "",
    bookingRows.length ? `${bookingRows.length} booking${bookingRows.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ") || "Nothing booked";

  return (
    <div>
      <PageHeader
        title={date === today ? "Today" : formatLongDateFromLocal(date)}
        subtitle={`${formatLongDateFromLocal(date)} · ${counts} · ${showroom.name}`}
        action={
          <div className="flex flex-wrap gap-2 text-sm">
            <Link className="btn btn-sm" href={`/app?date=${addLocalDays(date, -1)}`}>← Prev</Link>
            <Link className="btn btn-sm" href="/app">Today</Link>
            <Link className="btn btn-sm" href={`/app?date=${addLocalDays(date, 1)}`}>Next →</Link>
          </div>
        }
      />
      <Flash ok={sp(q.ok)} error={denied ? "You don't have permission for that page." : sp(q.error)} />
      {allItems.length > 0 && (rows.length > 0 ? 1 : 0) + typeChips.length > 1 && (
        <nav aria-label="Filter by visit type" className="mb-4 flex flex-wrap gap-2 text-sm">
          <Link href={chipHref("")} aria-current={!filter ? "page" : undefined} className={`rounded-md border px-3 py-1.5 font-medium ${!filter ? "border-foreground bg-foreground text-white" : "border-border bg-card"}`}>All {allItems.length}</Link>
          {rows.length > 0 && <Link href={chipHref("pickups")} aria-current={filter === "pickups" ? "page" : undefined} className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 font-medium ${filter === "pickups" ? "border-foreground bg-foreground text-white" : "border-border bg-card"}`}><span aria-hidden="true" className="h-2 w-2 rounded-full bg-[#0f766e]" />Pickups {visits.length}</Link>}
          {typeChips.map((t) => (
            <Link key={t.id} href={chipHref(t.id)} aria-current={filter === t.id ? "page" : undefined} className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 font-medium ${filter === t.id ? "border-foreground bg-foreground text-white" : "border-border bg-card"}`}>
              <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: colorOf(t.color).hex }} />{t.name} {bookingRows.filter((r) => r.type.id === t.id).length}
            </Link>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start gap-6">
      <div className="min-w-0 flex-[999_1_560px]">
      {items.length === 0 ? (
        <Empty>Nothing booked for this day.</Empty>
      ) : (
        <div className="space-y-3">
          {items.map((item, idx) => {
            // A red "now" line before the first visit that hasn't started yet (today only).
            const nowLine = date === today && item.at > now.getTime() && (idx === 0 || items[idx - 1].at <= now.getTime())
              ? <div key="now" role="separator" aria-label={`Now, ${formatTime(now, showroom.timezone)}`} className="flex items-center gap-2 text-xs font-bold text-danger"><span>NOW {formatTime(now, showroom.timezone)}</span><span aria-hidden="true" className="h-0.5 flex-1 bg-danger" /></div>
              : null;
            const card = (() => {
            if (item.kind === "booking") return <BookingCard key={item.row.booking.id} row={item.row} tz={showroom.timezone} />;
            const visit = item.visit;
            const first = visit[0];
            const { appointment } = first;
            const passed = appointment.startsAt < now;
            return (
              <Card key={appointment.groupId ?? appointment.id}>
                <div className="flex flex-wrap items-start gap-4">
                  <div className="w-24 shrink-0">
                    <p className="text-xl font-semibold">{formatTime(appointment.startsAt, showroom.timezone)}</p>
                    <p className="text-xs text-muted">to {formatTime(appointment.endsAt, showroom.timezone)}</p>
                    {visit.length > 1 && <Badge tone="accent">{visit.length} bikes</Badge>}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      <Link href={`/app/units/${first.unit.id}`} className="hover:text-accent">{first.order?.customerName ?? "Unassigned"}</Link><ContactFlag order={first.order} />
                      <span className="ml-2 text-sm font-normal text-muted">{visit.map((v) => v.order?.orderRef).filter(Boolean).join(", ")}</span>
                    </p>
                    <ul className="mt-1 space-y-2">
                      {visit.map(({ unit, order, storageDueCents }) => (
                        <li key={unit.id} className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="text-sm"><Link href={`/app/units/${unit.id}`} className="hover:text-accent">{unit.model}</Link> · {[unit.size, unit.colour].filter(Boolean).join(" · ")} · box {unit.boxTag}</p>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                              <StatusBadge status={unit.status} />
                              {order && (
                                <Badge tone={order.paymentStatus === "deposit" ? "warn" : "ok"}>
                                  {order.paymentStatus === "deposit" ? `Balance ${formatMoney(order.balanceCents)}` : "Paid in full"}
                                </Badge>
                              )}
                              {storageDueCents > 0 && <Badge tone="danger">Storage due {formatMoney(storageDueCents)}</Badge>}
                              {unit.earlyBird && <Badge tone="accent">Early bird — apply reward</Badge>}
                              {unit.noShowCount > 0 && <Badge tone="neutral">{unit.noShowCount} prior no-show</Badge>}
                            </div>
                          </div>
                          {unit.kind === "parts" ? (
                            <span className="flex items-center gap-2"><Badge>Parts</Badge><form action={collectPartsAction.bind(null, unit.id, `/app?date=${date}`)}><button type="submit" className="btn btn-primary btn-sm">Collected</button></form></span>
                          ) : (
                            <Link href={`/app/units/${unit.id}?handover=1`} className="btn btn-primary btn-sm">{unit.status === "picked_up" ? "Handed over" : "Start handover"}</Link>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                  {passed && (
                    <div className="flex shrink-0 flex-col gap-2">
                      <form action={recordNoShowAction.bind(null, first.unit.id, `/app?date=${date}`)}>
                        <button type="submit" className="btn btn-sm w-full">No-show{visit.length > 1 ? " (all)" : ""}</button>
                      </form>
                    </div>
                  )}
                </div>
              </Card>
            );
            })();
            return <Fragment key={item.kind === "booking" ? item.row.booking.id : (item.visit[0].appointment.groupId ?? item.visit[0].appointment.id)}>{nowLine}{card}</Fragment>;
          })}
        </div>
      )}
      </div>

      <aside className="min-w-0 flex-[1_1_280px] space-y-4">
        {store && (
          <section className="card" aria-label="Workshop today">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide">Workshop {date === today ? "today" : "this day"}</h2>
              <Link href="/app/workshop" className="text-xs underline">Open</Link>
            </div>
            {buildsDue.length === 0 ? (
              <p className="mt-2 text-sm text-muted">No builds due.</p>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {buildsDue.map((r) => {
                  const late = r.unit.status === "booked" && !!r.buildAt && r.buildAt < now;
                  return (
                    <li key={r.appointment.id} className="flex justify-between gap-2">
                      <Link href={`/app/units/${r.unit.id}`} className="min-w-0 truncate hover:text-accent">{r.unit.model} <span className="text-muted">· {r.order?.customerName ?? "—"}</span></Link>
                      <span className={`shrink-0 ${late ? "font-semibold text-danger" : r.unit.status === "ready" ? "text-ok" : "text-muted"}`}>
                        {r.unit.status === "ready" ? "ready" : r.unit.status === "building" ? "building" : r.buildAt ? `by ${formatTime(r.buildAt, showroom.timezone)}` : "today"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
        <section className="card" aria-label="Done for you" style={{ background: "#f5f4f1" }}>
          <h2 className="text-sm font-semibold uppercase tracking-wide">Done for you {date === today ? "today" : "this day"}</h2>
          {done.invites + done.reminders + done.otherMessages + done.failed === 0 ? (
            <p className="mt-2 text-sm text-muted">Nothing sent yet.</p>
          ) : (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
              {done.invites > 0 && <li>{done.invites} pickup invite{done.invites === 1 ? "" : "s"} sent</li>}
              {done.reminders > 0 && <li>{done.reminders} reminder{done.reminders === 1 ? "" : "s"} sent</li>}
              {done.otherMessages > 0 && <li>{done.otherMessages} other message{done.otherMessages === 1 ? "" : "s"} sent</li>}
              {done.failed > 0 && <li className="text-danger">{done.failed} didn&apos;t send · <Link href="/app/watchlist" className="underline">see Alerts</Link></li>}
            </ul>
          )}
        </section>
      </aside>
      </div>
    </div>
  );
}

const OUTCOME: Record<string, { label: string; tone: "ok" | "danger" | "neutral" }> = {
  completed: { label: "done", tone: "ok" },
  no_show: { label: "no-show", tone: "danger" },
};

/** A booking of a booking type on the day list: who, what, how to reach them; Open for the booking (status, move, cancel). */
function BookingCard({ row, tz }: { row: BookingRow; tz: string }) {
  const { booking: b, type } = row;
  const outcome = b.status === "completed" ? { ...OUTCOME.completed, label: doneWords(type.location).done } : OUTCOME[b.status];
  return (
    <Card>
      <div className="flex flex-wrap items-start gap-4">
        <span aria-hidden="true" className="w-1 self-stretch rounded-full" style={{ background: colorOf(type.color).hex }} />
        <div className="w-24 shrink-0">
          <p className="text-xl font-semibold">{formatTime(b.startsAt, tz)}</p>
          <p className="text-xs text-muted">to {formatTime(b.endsAt, tz)}</p>
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            <Link href={`/app/bookings/${b.id}`} className="hover:text-accent">{b.customerName}</Link>
            <span className="ml-2 text-sm font-normal text-muted">{type.name}</span>
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <Badge tone="accent">{LOCATION_LABEL[type.location as BookingLocation]}</Badge>
            {outcome && <Badge tone={outcome.tone}>{outcome.label}</Badge>}
            <span className="text-muted">{[b.customerPhone, b.customerEmail].filter(Boolean).join(" · ")}</span>
          </div>
          {b.customerNote && <p className="mt-1 text-sm text-muted">&ldquo;{b.customerNote}&rdquo;</p>}
        </div>
        <Link href={`/app/bookings/${b.id}`} className={`btn btn-sm shrink-0 ${b.status === "booked" ? "btn-primary" : ""}`}>Open</Link>
      </div>
    </Card>
  );
}
