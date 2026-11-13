import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { Alert, Card } from "@/components/ui";
import { sp, type SearchParams } from "@/lib/flash";
import { formatLongDate, formatLongDateFromLocal, formatTime } from "@/lib/time";
import { getBookingByToken } from "@/lib/type-bookings";
import { getTypeAvailability } from "@/lib/type-slots";
import { rescheduleTypeAction } from "../../../actions";
import { SlotPicker } from "@/components/slot-picker";
import { zoneLabel } from "../../../zone";

export const metadata = { title: "Change time" };

export default async function RescheduleBookingPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<SearchParams> }) {
  const { token } = await params;
  const q = await searchParams;
  const view = await getBookingByToken(db, token);
  if (!view || view.booking.status !== "booked" || view.booking.startsAt <= new Date()) redirect(`/book/m/${token}`);
  const { booking, type, showroom } = view;
  const tz = showroom.timezone;
  // The customer's own booking doesn't block the times around it.
  const days = await getTypeAvailability(db, { showroom, type, exceptBookingId: booking.id });
  const date = sp(q.date);
  const time = sp(q.time);
  const slot = date && time ? days.find((d) => d.date === date)?.slots.find((s) => s.time === time) : undefined;
  const base = `/book/m/${token}/reschedule`;
  const error = sp(q.error);
  return (
    <div className="space-y-4">
      <div>
        <Link href={`/book/m/${token}`} className="text-sm text-accent underline">← Back</Link>
        <h1 className="mt-2 text-2xl font-semibold">Change time</h1>
        <p className="mt-1 text-sm text-muted">{type.name} · now {formatLongDate(booking.startsAt, tz)} at {formatTime(booking.startsAt, tz)}</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {slot ? (
        <Card title="Move to">
          <form action={rescheduleTypeAction.bind(null, token)} className="space-y-3">
            <input type="hidden" name="starts_at" value={slot.startsAt.toISOString()} />
            <p className="text-lg font-semibold">{formatLongDateFromLocal(date!)}</p>
            <p>{formatTime(slot.startsAt, tz)} – {formatTime(slot.endsAt, tz)}</p>
            <button type="submit" className="btn btn-primary btn-block">Confirm new time</button>
          </form>
        </Card>
      ) : (
        <SlotPicker days={days} base={base} date={date} tz={tz} />
      )}
      <p className="text-xs text-muted">Times are shown in {zoneLabel(tz)}.</p>
    </div>
  );
}
