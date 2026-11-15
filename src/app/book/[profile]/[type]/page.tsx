import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { bookingTypes } from "@/db/schema";
import { BookingCalendar, BookingInfo } from "@/components/booking-calendar";
import { hostsFor } from "@/lib/staff-photos";
import { Alert, Field } from "@/components/ui";
import { colorOf, LOCATION_LABEL, type BookingLocation } from "@/lib/booking-types";
import { sp, type SearchParams } from "@/lib/flash";
import { getShowroom } from "@/lib/showroom";
import { formatLongDateFromLocal, formatTime } from "@/lib/time";
import { getTypeAvailability } from "@/lib/type-slots";
import { bookTypeAction } from "../../actions";
import { zoneLabel } from "../../zone";
import { ZonePicker } from "@/components/zone-picker";
import { daysInZone, viewZone } from "@/lib/view-tz";
import { QuestionFields } from "@/components/question-fields";
import { readQuestions } from "@/lib/booking-questions";

export const metadata = { title: "Pick a time" };

/** Calendly-style: pick a day on the month calendar, a time, then "Next" to give name and contact details. */
export default async function BookTypePage({ params, searchParams }: { params: Promise<{ profile: string; type: string }>; searchParams: Promise<SearchParams> }) {
  const { profile, type: typeSlug } = await params;
  const q = await searchParams;
  const showroom = await getShowroom(db, profile).catch(() => null);
  if (!showroom) notFound();
  const [type] = await db.select().from(bookingTypes).where(and(eq(bookingTypes.showroomId, showroom.id), eq(bookingTypes.slug, typeSlug)));
  if (!type || type.kind !== "standard" || type.access !== "public" || !type.active) notFound();
  const storeTz = showroom.timezone;
  // Times in the customer's own zone (?tz=, filled in from their browser by the zone picker).
  const tz = viewZone(sp(q.tz), storeTz);
  const days = daysInZone(await getTypeAvailability(db, { showroom, type }), storeTz, tz);
  const date = sp(q.date);
  const time = sp(q.time);
  const month = sp(q.month);
  const slot = date && time ? days.find((d) => d.date === date)?.slots.find((s) => s.time === time) : undefined;
  // Details passed in by a share link or the website embed (data-name / data-email / data-phone) fill the form.
  const prefill = { name: sp(q.name)?.slice(0, 200), email: sp(q.email)?.slice(0, 200), phone: sp(q.phone)?.slice(0, 40), tz: tz === storeTz ? undefined : tz };
  const prefillQuery = new URLSearchParams(Object.entries(prefill).filter((e): e is [string, string] => !!e[1])).toString();
  const base = `/book/${showroom.slug}/${type.slug}${prefillQuery ? `?${prefillQuery}` : ""}`;
  const join = prefillQuery ? "&" : "?";
  const error = sp(q.error);
  const accent = colorOf(type.color).hex;
  const where = type.location === "in_person" && showroom.addressLine ? showroom.addressLine : LOCATION_LABEL[type.location as BookingLocation];
  const hosts = await hostsFor(db, type.hostIds);
  const info = (
    <BookingInfo
      hosts={hosts}
      brand={showroom.name}
      title={type.name}
      durationMin={type.durationMin}
      location={where}
      description={type.description}
      extra={slot ? <p className="text-sm font-medium" style={{ color: accent }}>{formatTime(slot.startsAt, tz)} – {formatTime(slot.endsAt, tz)}, {formatLongDateFromLocal(date!)}</p> : undefined}
    />
  );

  return (
    <div className="space-y-4">
      <Link href={`/book/${showroom.slug}`} className="text-sm text-accent underline">← All appointment types</Link>
      {error && <Alert tone="danger">{error}</Alert>}
      {date && time && !slot && <Alert tone="danger">That time was just taken or is no longer open. Please pick another.</Alert>}
      {slot && sp(q.confirm) === "1" ? (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm lg:grid lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
          <div className="border-b border-border p-6 lg:border-b-0 lg:border-r">
            {info}
            <p className="mt-3 text-xs text-muted">{zoneLabel(tz)}</p>
          </div>
          <div className="p-6">
            <Link href={`${base}${join}month=${date!.slice(0, 7)}&date=${date}&time=${time}`} className="text-sm text-accent underline">← Back</Link>
            <h2 className="mt-2 text-lg font-semibold">Enter details</h2>
            <form action={bookTypeAction.bind(null, showroom.slug, type.slug)} className="mt-4 max-w-md space-y-3">
              <input type="hidden" name="starts_at" value={slot.startsAt.toISOString()} />
              <input type="hidden" name="date" value={date} />
              <input type="hidden" name="time" value={time} />
              {tz !== storeTz && <input type="hidden" name="tz" value={tz} />}
              <Field label="Name" htmlFor="bk_name"><input id="bk_name" name="name" required autoComplete="name" defaultValue={prefill.name} className="input" /></Field>
              <Field label="Email" htmlFor="bk_email"><input id="bk_email" name="email" type="email" autoComplete="email" defaultValue={prefill.email} className="input" required={type.location === "video"} /></Field>
              <Field label="Phone" htmlFor="bk_phone" hint={type.location === "phone" ? "We'll call you on this number." : "Email, phone or both, so we can confirm."}>
                <input id="bk_phone" name="phone" type="tel" autoComplete="tel" defaultValue={prefill.phone} className="input" required={type.location === "phone"} />
              </Field>
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" name="sms_consent" className="mt-1 h-4 w-4 rounded border-border accent-accent" />
                <span>Text me about this appointment. Standard rates apply; reply STOP to opt out.</span>
              </label>
              <QuestionFields questions={readQuestions(type.questions)} idPrefix="bk" />
              <Field label="Anything we should know? (optional)" htmlFor="bk_note"><textarea id="bk_note" name="note" rows={3} className="input" /></Field>
              <button type="submit" className="btn btn-block text-white" style={{ background: accent, borderColor: accent }}>Schedule</button>
            </form>
          </div>
        </div>
      ) : (
        <BookingCalendar days={days} tz={tz} base={base} month={month} date={date} time={time} accent={accent} info={info} zone={<ZonePicker current={tz} storeTz={storeTz} />} />
      )}
    </div>
  );
}
