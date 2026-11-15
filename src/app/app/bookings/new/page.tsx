import Link from "next/link";
import { db } from "@/db/client";
import { zoneLabel } from "@/app/book/zone";
import { BookingCalendar, BookingInfo } from "@/components/booking-calendar";
import { Card, Field, Flash, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { colorOf, ensureDefaultBookingTypes,
  listBookingTypes, LOCATION_LABEL, type BookingLocation } from "@/lib/booking-types";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { formatLongDateFromLocal, formatTime } from "@/lib/time";
import { getTypeAvailability } from "@/lib/type-slots";
import { staffCreateTypeBookingAction } from "../../actions";
import { QuestionFields } from "@/components/question-fields";
import { readQuestions } from "@/lib/booking-questions";

export const metadata = { title: "Book for a customer" };

/**
 * Staff book on a customer's behalf (phone call, walk-in): pick the booking type, a time, then the customer's
 * details. Invite-only types can be booked here. The customer gets the same confirmation as booking online.
 */
export default async function NewBookingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const user = await requireUser("staff");
  const showroom = await currentShowroom(user);
  await ensureDefaultBookingTypes(db, showroom);
  const types = (await listBookingTypes(db, showroom.id)).filter((t) => t.kind === "standard" && t.active);
  const type = types.find((t) => t.id === sp(q.type));
  const tz = showroom.timezone;
  const days = type ? await getTypeAvailability(db, { showroom, type }) : [];
  const date = sp(q.date);
  const time = sp(q.time);
  const slot = date && time && sp(q.confirm) === "1" ? days.find((d) => d.date === date)?.slots.find((s) => s.time === time) : undefined;
  const base = type ? `/app/bookings/new?type=${type.id}` : "/app/bookings/new";

  return (
    // Full width so the calendar can lay out in three columns (details · month · times), like the customer page;
    // the type picker and the details form stay at a readable width.
    <div>
      <PageHeader title="Book for a customer" subtitle={`${showroom.name} · for a customer who phoned or walked in. They get the usual confirmation.`} />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      {!type ? (
        types.length === 0 ? (
          <Card><p className="text-sm">No booking types are set up here yet. A manager can add them in <Link href="/app/settings/booking-types" className="underline">Settings › Booking types</Link>. Bike pickups are booked from the bike&apos;s page.</p></Card>
        ) : (
          <Card title="What are they booking?" className="max-w-4xl">
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {types.map((t) => (
                <li key={t.id}>
                  <Link href={`/app/bookings/new?type=${t.id}`} className="block rounded-lg border border-border p-3 hover:border-accent">
                    <span className="font-medium">{t.name}</span>
                    <span className="block text-xs text-muted">{t.durationMin} min · {LOCATION_LABEL[t.location as BookingLocation]}{t.access === "invite" ? " · invite only" : ""}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted">Bike pickups are booked from the bike&apos;s page.</p>
          </Card>
        )
      ) : (
        <div className="space-y-4">
          <p className="text-sm"><Link href="/app/bookings/new" className="text-accent underline">← Another type</Link> · <span className="font-medium">{type.name}</span> <span className="text-muted">({type.durationMin} min)</span></p>
          {slot ? (
            <Card title={`${formatLongDateFromLocal(date!)} · ${formatTime(slot.startsAt, tz)} – ${formatTime(slot.endsAt, tz)}`} className="max-w-2xl">
              <form action={staffCreateTypeBookingAction.bind(null, type.id)} className="space-y-3">
                <input type="hidden" name="starts_at" value={slot.startsAt.toISOString()} />
                <input type="hidden" name="date" value={date} />
                <input type="hidden" name="time" value={time} />
                <Field label="Customer name" htmlFor="nb_name"><input id="nb_name" name="name" required className="input" /></Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Phone" htmlFor="nb_phone"><input id="nb_phone" name="phone" type="tel" className="input" /></Field>
                  <Field label="Email" htmlFor="nb_email"><input id="nb_email" name="email" type="email" className="input" /></Field>
                </div>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="sms_consent" className="h-4 w-4" /> Customer agrees to text messages about this booking</label>
                <QuestionFields questions={readQuestions(type.questions)} idPrefix="nb" />
                <Field label="Note" htmlFor="nb_note"><textarea id="nb_note" name="note" rows={2} className="input" /></Field>
                <div className="flex gap-2">
                  <button type="submit" className="btn btn-primary">Book</button>
                  <Link href={`${base}&date=${date}`} className="btn">Pick another time</Link>
                </div>
              </form>
            </Card>
          ) : (
            <BookingCalendar
              days={days}
              tz={tz}
              base={base}
              month={sp(q.month)}
              date={date}
              time={time}
              accent={colorOf(type.color).hex}
              zone={zoneLabel(tz)}
              info={<BookingInfo brand={showroom.name} title={type.name} durationMin={type.durationMin} location={LOCATION_LABEL[type.location as BookingLocation]} description={type.access === "invite" ? "Invite only: customers can't book this online." : undefined} />}
            />
          )}
        </div>
      )}
    </div>
  );
}
