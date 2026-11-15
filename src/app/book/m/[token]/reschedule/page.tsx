import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { BookingCalendar, BookingInfo } from "@/components/booking-calendar";
import { hostsFor } from "@/lib/staff-photos";
import { Alert, Card } from "@/components/ui";
import { colorOf, LOCATION_LABEL, type BookingLocation } from "@/lib/booking-types";
import { sp, type SearchParams } from "@/lib/flash";
import { formatLongDate, formatLongDateFromLocal, formatTime } from "@/lib/time";
import { getBookingByToken } from "@/lib/type-bookings";
import { getTypeAvailability } from "@/lib/type-slots";
import { rescheduleTypeAction } from "../../../actions";
import { zoneLabel } from "../../../zone";
import { ZonePicker } from "@/components/zone-picker";
import { daysInZone, viewZone } from "@/lib/view-tz";

export const metadata = { title: "Change time" };

export default async function RescheduleBookingPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<SearchParams> }) {
  const { token } = await params;
  const q = await searchParams;
  const view = await getBookingByToken(db, token);
  if (!view || view.booking.status !== "booked" || view.booking.startsAt <= new Date()) redirect(`/book/m/${token}`);
  const { booking, type, showroom } = view;
  const storeTz = showroom.timezone;
  const tz = viewZone(sp(q.tz), storeTz);
  // The customer's own booking doesn't block the times around it.
  const days = daysInZone(await getTypeAvailability(db, { showroom, type, exceptBookingId: booking.id }), storeTz, tz);
  const date = sp(q.date);
  const time = sp(q.time);
  const slot = date && time ? days.find((d) => d.date === date)?.slots.find((s) => s.time === time) : undefined;
  const tzq = tz === storeTz ? "" : `tz=${encodeURIComponent(tz)}`;
  const base = `/book/m/${token}/reschedule${tzq ? `?${tzq}` : ""}`;
  const error = sp(q.error);
  const accent = colorOf(type.color).hex;
  const hosts = await hostsFor(db, type.hostIds);
  const info = (
    <BookingInfo
      hosts={hosts}
      brand={showroom.name}
      title={type.name}
      durationMin={type.durationMin}
      location={type.location === "in_person" ? showroom.addressLine : LOCATION_LABEL[type.location as BookingLocation]}
      extra={<p className="text-sm">Now: {formatLongDate(booking.startsAt, tz)} at {formatTime(booking.startsAt, tz)}</p>}
    />
  );
  return (
    <div className="space-y-4">
      <Link href={`/book/m/${token}${tzq ? `?${tzq}` : ""}`} className="text-sm text-accent underline">← Back to your booking</Link>
      {error && <Alert tone="danger">{error}</Alert>}
      {slot && sp(q.confirm) === "1" ? (
        <div className="mx-auto max-w-md">
          <Card title="Move to">
            <form action={rescheduleTypeAction.bind(null, token)} className="space-y-3">
              <input type="hidden" name="starts_at" value={slot.startsAt.toISOString()} />
              {tzq && <input type="hidden" name="tz" value={tz} />}
              <p className="text-lg font-semibold">{formatLongDateFromLocal(date!)}</p>
              <p>{formatTime(slot.startsAt, tz)} – {formatTime(slot.endsAt, tz)} <span className="text-sm text-muted">({zoneLabel(tz)})</span></p>
              <button type="submit" className="btn btn-block text-white" style={{ background: accent, borderColor: accent }}>Confirm new time</button>
              <Link href={`${base}${tzq ? "&" : "?"}date=${date}`} className="block text-center text-sm text-accent underline">Pick another time</Link>
            </form>
          </Card>
        </div>
      ) : (
        <BookingCalendar days={days} tz={tz} base={base} month={sp(q.month)} date={date} time={time} accent={accent} info={info} zone={<ZonePicker current={tz} storeTz={storeTz} />} />
      )}
    </div>
  );
}
