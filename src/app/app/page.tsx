import Link from "next/link";
import { db } from "@/db/client";
import { StatusBadge } from "@/components/status-badge";
import { Badge, Card, Empty, Flash, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import { sp, type SearchParams } from "@/lib/flash";
import { todayAppointments } from "@/lib/queries";
import { addLocalDays, formatLongDateFromLocal, formatTime, toLocalDate } from "@/lib/time";
import { checkInBookingAction, collectPartsAction, noShowBookingAction, recordNoShowAction } from "./actions";
import { colorOf, LOCATION_LABEL, type BookingLocation } from "@/lib/booking-types";
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
  const [rows, bookingRows] = await Promise.all([todayAppointments(db, showroom, date, now), listBookings(db, showroom.id, date, date)]);
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
  const items: ({ kind: "visit"; at: number; visit: (typeof rows) } | { kind: "booking"; at: number; row: BookingRow })[] = [
    ...visits.map((visit) => ({ kind: "visit" as const, at: visit[0].appointment.startsAt.getTime(), visit })),
    ...bookingRows.map((row) => ({ kind: "booking" as const, at: row.booking.startsAt.getTime(), row })),
  ].sort((a, b) => a.at - b.at);
  const back = `/app?date=${date}`;
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
            <Link className="btn btn-primary btn-sm" href="/app/bookings/new">+ Book for a customer</Link>
            <Link className="btn btn-sm" href={`/app?date=${addLocalDays(date, -1)}`}>← Prev</Link>
            <Link className="btn btn-sm" href="/app">Today</Link>
            <Link className="btn btn-sm" href={`/app?date=${addLocalDays(date, 1)}`}>Next →</Link>
          </div>
        }
      />
      <Flash ok={sp(q.ok)} error={denied ? "You don't have permission for that page." : sp(q.error)} />
      {items.length === 0 ? (
        <Empty>Nothing booked for this day.</Empty>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            if (item.kind === "booking") return <BookingCard key={item.row.booking.id} row={item.row} tz={showroom.timezone} now={now} back={back} />;
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
          })}
        </div>
      )}
    </div>
  );
}

const OUTCOME: Record<string, { label: string; tone: "ok" | "danger" | "neutral" }> = {
  completed: { label: "checked in", tone: "ok" },
  no_show: { label: "no-show", tone: "danger" },
};

/** A booking of a booking type on the day list: who, what, how to reach them, and check-in / no-show. */
function BookingCard({ row, tz, now, back }: { row: BookingRow; tz: string; now: Date; back: string }) {
  const { booking: b, type } = row;
  const outcome = OUTCOME[b.status];
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
        {b.status === "booked" && (
          <div className="flex shrink-0 flex-col gap-2">
            <form action={checkInBookingAction.bind(null, b.id, back)}><button type="submit" className="btn btn-primary btn-sm w-full">Check in</button></form>
            {b.startsAt < now && <form action={noShowBookingAction.bind(null, b.id, back)}><button type="submit" className="btn btn-sm w-full">No-show</button></form>}
          </div>
        )}
      </div>
    </Card>
  );
}
