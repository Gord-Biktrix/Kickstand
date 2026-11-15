import Link from "next/link";
import { db } from "@/db/client";
import { Alert, Badge, Card } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { LOCATION_LABEL, type BookingLocation } from "@/lib/booking-types";
import { sp, type SearchParams } from "@/lib/flash";
import { formatLongDate, formatTime } from "@/lib/time";
import { getBookingByToken } from "@/lib/type-bookings";
import { cancelTypeAction } from "../../actions";
import { zoneLabel } from "../../zone";
import { ZoneAuto } from "@/components/zone-picker";
import { viewZone } from "@/lib/view-tz";

export const metadata = { title: "Your booking" };

const OK: Record<string, string> = {
  booked: "You're booked. A confirmation is on its way.",
  rescheduled: "Your booking has moved to the new time.",
  cancelled: "Your booking is cancelled.",
};

/** The customer's manage page: what, when, where, add to calendar, reschedule, cancel. */
export default async function ManageBookingPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<SearchParams> }) {
  const { token } = await params;
  const q = await searchParams;
  const view = await getBookingByToken(db, token);
  if (!view) {
    return <div className="mx-auto max-w-md"><Card title="Link not found"><p className="text-sm">This booking link isn&apos;t valid. Check the link in your confirmation, or book again.</p></Card></div>;
  }
  const { booking, type, showroom } = view;
  const tz = viewZone(sp(q.tz), showroom.timezone);
  const tzq = tz === showroom.timezone ? "" : `?tz=${encodeURIComponent(tz)}`;
  const active = booking.status === "booked" && booking.startsAt > new Date();
  const ok = sp(q.ok);
  const error = sp(q.error);
  const where = type.location === "in_person"
    ? showroom.addressLine
    : type.location === "phone"
      ? `We'll call you${booking.customerPhone ? ` at ${booking.customerPhone}` : ""}.`
      : LOCATION_LABEL[type.location as BookingLocation];

  return (
    <div className="mx-auto max-w-md space-y-4">
      <ZoneAuto storeTz={showroom.timezone} />
      {ok && OK[ok] && <Alert tone="ok">{OK[ok]}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      <Card
        title={type.name}
        action={booking.status === "cancelled" ? <Badge>cancelled</Badge> : active ? <Badge tone="ok">booked</Badge> : <Badge>past</Badge>}
      >
        <p className="text-lg font-semibold">{formatLongDate(booking.startsAt, tz)}</p>
        <p>{formatTime(booking.startsAt, tz)} – {formatTime(booking.endsAt, tz)} <span className="text-sm text-muted">({zoneLabel(tz)})</span></p>
        <p className="mt-2 text-sm">{showroom.name}</p>
        {where && <p className="text-sm text-muted">{where}</p>}
        {booking.customerNote && <p className="mt-2 text-sm text-muted">Your note: {booking.customerNote}</p>}
        {active && (
          <div className="mt-4 flex flex-wrap gap-2">
            <a href={`/book/m/${token}/ics`} className="btn btn-sm">Add to calendar</a>
            <Link href={`/book/m/${token}/reschedule${tzq}`} className="btn btn-sm">Change time</Link>
            <form action={cancelTypeAction.bind(null, token)}>
              <ConfirmButton className="btn btn-danger btn-sm" message="Cancel this booking?">Cancel booking</ConfirmButton>
            </form>
          </div>
        )}
      </Card>
      {!active && <Link href={`/book/${showroom.slug}`} className="text-sm text-accent underline">Book another time</Link>}
      {showroom.phone && <p className="text-xs text-muted">Questions? Call {showroom.name} at {showroom.phone}.</p>}
    </div>
  );
}
