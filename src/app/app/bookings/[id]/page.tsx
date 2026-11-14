import { Fragment } from "react";
import Link from "next/link";
import { readAnswers } from "@/lib/booking-questions";
import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { ConfirmButton } from "@/components/confirm-button";
import { BookingCalendar, BookingInfo } from "@/components/booking-calendar";
import { Badge, Card, Flash, PageHeader } from "@/components/ui";
import { listStaff, requireUser } from "@/lib/auth";
import { colorOf, LOCATION_LABEL, type BookingLocation } from "@/lib/booking-types";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { formatDateTime, formatLongDate, formatLongDateFromLocal, formatTime } from "@/lib/time";
import { bookingUrls, getBookingDetail } from "@/lib/type-bookings";
import { bookingCustomerKey } from "@/lib/customers";
import { getTypeAvailability } from "@/lib/type-slots";
import { lightspeedEnabled } from "@/lib/lightspeed";
import { lightspeedWorkorderUrl } from "@/lib/workorders";
import { checkInBookingAction, noShowBookingAction, retryBookingWorkorderAction, staffCancelTypeBookingAction, staffRescheduleTypeBookingAction, undoBookingOutcomeAction } from "../../actions";

export const metadata = { title: "Booking" };

const STATUS: Record<string, { label: string; tone: "ok" | "danger" | "neutral" | "accent" }> = {
  booked: { label: "booked", tone: "accent" },
  completed: { label: "checked in", tone: "ok" },
  no_show: { label: "no-show", tone: "danger" },
  cancelled: { label: "cancelled", tone: "neutral" },
};

const EVENT_LABEL: Record<string, string> = {
  booking_confirmed: "Booked",
  booking_rescheduled: "Moved to a new time",
  booking_cancelled: "Cancelled",
  booking_reminder_day_before: "Day-before reminder sent",
  booking_checked_in: "Checked in",
  booking_no_show: "Marked no-show",
  booking_outcome_undone: "Check-in / no-show undone",
  booking_workorder_created: "Lightspeed work order created",
  booking_workorder_updated: "Lightspeed work order updated",
  booking_workorder_failed: "Lightspeed work order failed",
  booking_calendar_failed: "Google Calendar copy failed",
};

/** One booking: the booking itself with Check in / No-show / Change time / Cancel beside it, then its timeline. */
export default async function BookingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const { id } = await params;
  const q = await searchParams;
  const user = await requireUser("staff");
  const showroom = await currentShowroom(user);
  const detail = await getBookingDetail(db, showroom.id, id);
  if (!detail) notFound();
  const { booking: b, type, timeline } = detail;
  const tz = showroom.timezone;
  const now = new Date();
  const moving = sp(q.move) === "1";
  const date = sp(q.date);
  const time = sp(q.time);
  const days = moving && b.status === "booked" ? await getTypeAvailability(db, { showroom, type, exceptBookingId: b.id }) : [];
  const slot = date && time && sp(q.confirm) === "1" ? days.find((d) => d.date === date)?.slots.find((s) => s.time === time) : undefined;
  const staffNames = new Map((await listStaff()).map((s) => [s.id, s.name]));
  const who = (actor: string) => staffNames.get(actor) ?? (actor === "customer" ? "Customer" : actor);
  const status = STATUS[b.status] ?? STATUS.booked;
  const self = `/app/bookings/${b.id}`;

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={<Link href={`/app/customers/${encodeURIComponent(bookingCustomerKey(b))}`} className="hover:text-accent">{b.customerName}</Link>}
        subtitle={`${type.name} · ${showroom.name}`}
        action={<Link href={`/app?date=${b.onDate}`} className="btn btn-sm">← {formatLongDateFromLocal(b.onDate)}</Link>}
      />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <Card
        title={<span className="inline-flex items-center gap-2">{formatLongDate(b.startsAt, tz)} · {formatTime(b.startsAt, tz)} – {formatTime(b.endsAt, tz)}</span>}
        action={<Badge tone={status.tone}>{status.label}</Badge>}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">What</dt><dd>{type.name} · {LOCATION_LABEL[type.location as BookingLocation]}</dd>
            <dt className="text-muted">Phone</dt><dd>{b.customerPhone ? <a href={`tel:${b.customerPhone}`} className="underline">{b.customerPhone}</a> : "—"}{b.smsConsent && <span className="ml-2 text-xs text-muted">texts OK</span>}</dd>
            <dt className="text-muted">Email</dt><dd>{b.customerEmail ? <a href={`mailto:${b.customerEmail}`} className="underline">{b.customerEmail}</a> : "—"}</dd>
            {readAnswers(b.answers).map((a, i) => <Fragment key={i}><dt className="text-muted">{a.question}</dt><dd className="font-medium">{a.answer}</dd></Fragment>)}
            {b.customerNote && <><dt className="text-muted">Note</dt><dd>{b.customerNote}</dd></>}
            <dt className="text-muted">Booked by</dt><dd>{who(b.createdBy)}</dd>
            {type.createsWorkOrder && (
              <>
                <dt className="text-muted">Lightspeed</dt>
                <dd>
                  {b.lsWorkorderId ? (
                    <a href={lightspeedWorkorderUrl(b.lsWorkorderId)} target="_blank" rel="noreferrer" className="underline">Work order #{b.lsWorkorderId}</a>
                  ) : !lightspeedEnabled(showroom) ? (
                    <span className="text-muted">Lightspeed link is off for this store</span>
                  ) : b.status === "booked" ? (
                    <form action={retryBookingWorkorderAction.bind(null, b.id)} className="inline"><span className="text-danger">No work order yet</span> <button type="submit" className="btn btn-sm ml-2">Create it now</button></form>
                  ) : "—"}
                </dd>
              </>
            )}
          </dl>
          <div className="flex flex-col gap-2">
            {b.status === "booked" && (
              <>
                <form action={checkInBookingAction.bind(null, b.id, self)}><button type="submit" className="btn btn-primary btn-sm w-full">Check in</button></form>
                {b.startsAt < now && <form action={noShowBookingAction.bind(null, b.id, self)}><button type="submit" className="btn btn-sm w-full">No-show</button></form>}
                {b.startsAt > now && <Link href={`${self}?move=1`} className="btn btn-sm">Change time</Link>}
                <form action={staffCancelTypeBookingAction.bind(null, b.id)}><ConfirmButton className="btn btn-danger btn-sm w-full" message={`Cancel ${b.customerName}'s ${type.name}? They're told through Klaviyo.`}>Cancel</ConfirmButton></form>
              </>
            )}
            {(b.status === "completed" || b.status === "no_show") && (
              <form action={undoBookingOutcomeAction.bind(null, b.id)}><button type="submit" className="btn btn-sm">Undo {status.label}</button></form>
            )}
          </div>
        </div>
        {b.status === "booked" && (
          <p className="mt-3 text-xs text-muted">Customer&apos;s own link: <a href={bookingUrls(b).manage_url} target="_blank" rel="noreferrer" className="underline">manage page</a> (they can change or cancel there).</p>
        )}
      </Card>

      {moving && b.status === "booked" && (
        <div className="mt-4">
          {slot ? (
            <Card title="Move to">
              <form action={staffRescheduleTypeBookingAction.bind(null, b.id)} className="space-y-3">
                <input type="hidden" name="starts_at" value={slot.startsAt.toISOString()} />
                <p className="font-semibold">{formatLongDateFromLocal(date!)} · {formatTime(slot.startsAt, tz)} – {formatTime(slot.endsAt, tz)}</p>
                <div className="flex gap-2">
                  <button type="submit" className="btn btn-primary btn-sm">Confirm new time</button>
                  <Link href={`${self}?move=1&date=${date}`} className="btn btn-sm">Pick another</Link>
                </div>
              </form>
            </Card>
          ) : (
            <BookingCalendar
              days={days}
              tz={tz}
              base={`${self}?move=1`}
              month={sp(q.month)}
              date={date}
              time={time}
              accent={colorOf(type.color).hex}
              zone={tz}
              info={<BookingInfo brand={showroom.name} title={`Move ${b.customerName}`} durationMin={type.durationMin} location={type.name} extra={<p className="text-sm">Now: {formatLongDate(b.startsAt, tz)} {formatTime(b.startsAt, tz)}</p>} />}
            />
          )}
        </div>
      )}

      <Card title="Timeline" className="mt-4">
        {timeline.length === 0 ? <p className="text-sm text-muted">Nothing yet.</p> : (
          <ul className="divide-y divide-border text-sm">
            {timeline.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {EVENT_LABEL[e.type] ?? e.type}
                  {typeof e.payload.workorder_id === "string" && <span className="text-muted"> #{e.payload.workorder_id}{e.payload.customer_matched === true ? " (existing customer)" : e.payload.customer_matched === false ? " (new customer)" : ""}</span>}
                  {typeof e.payload.error === "string" && <span className="text-danger"> · {e.payload.error}</span>}
                  {e.klaviyoStatus === "failed" && <Badge tone="danger">message not sent</Badge>}
                </span>
                <span className="text-xs text-muted">{who(e.actor)} · {formatDateTime(e.createdAt, tz)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
