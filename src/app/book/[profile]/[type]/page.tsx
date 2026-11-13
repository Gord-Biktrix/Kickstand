import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { bookingTypes } from "@/db/schema";
import { Alert, Card, Field } from "@/components/ui";
import { LOCATION_LABEL, type BookingLocation } from "@/lib/booking-types";
import { sp, type SearchParams } from "@/lib/flash";
import { getShowroom } from "@/lib/showroom";
import { formatLongDateFromLocal, formatTime } from "@/lib/time";
import { getTypeAvailability } from "@/lib/type-slots";
import { bookTypeAction } from "../../actions";
import { SlotPicker } from "@/components/slot-picker";
import { zoneLabel } from "../../zone";

export const metadata = { title: "Pick a time" };

/** Pick a day, a time, then give name and contact details. Only public, switched-on standard types. */
export default async function BookTypePage({ params, searchParams }: { params: Promise<{ profile: string; type: string }>; searchParams: Promise<SearchParams> }) {
  const { profile, type: typeSlug } = await params;
  const q = await searchParams;
  const showroom = await getShowroom(db, profile).catch(() => null);
  if (!showroom) notFound();
  const [type] = await db.select().from(bookingTypes).where(and(eq(bookingTypes.showroomId, showroom.id), eq(bookingTypes.slug, typeSlug)));
  if (!type || type.kind !== "standard" || type.access !== "public" || !type.active) notFound();
  const tz = showroom.timezone;
  const days = await getTypeAvailability(db, { showroom, type });
  const date = sp(q.date);
  const time = sp(q.time);
  const slot = date && time ? days.find((d) => d.date === date)?.slots.find((s) => s.time === time) : undefined;
  const base = `/book/${showroom.slug}/${type.slug}`;
  const error = sp(q.error);

  return (
    <div className="space-y-4">
      <div>
        <Link href={slot ? `${base}?date=${date}` : date ? base : `/book/${showroom.slug}`} className="text-sm text-accent underline">← Back</Link>
        <h1 className="mt-2 text-2xl font-semibold">{type.name}</h1>
        <p className="mt-1 text-sm text-muted">{showroom.name} · {type.durationMin} min · {LOCATION_LABEL[type.location as BookingLocation]}</p>
        {type.description && <p className="mt-2 text-sm">{type.description}</p>}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {date && time && !slot && <Alert tone="danger">That time was just taken or is no longer open. Please pick another.</Alert>}

      {slot ? (
        <Card title="Your details">
          <form action={bookTypeAction.bind(null, showroom.slug, type.slug)} className="space-y-3">
            <input type="hidden" name="starts_at" value={slot.startsAt.toISOString()} />
            <input type="hidden" name="date" value={date} />
            <input type="hidden" name="time" value={time} />
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="font-semibold">{formatLongDateFromLocal(date!)}</p>
              <p>{formatTime(slot.startsAt, tz)} – {formatTime(slot.endsAt, tz)} <span className="text-sm text-muted">({zoneLabel(tz)})</span></p>
              {type.location === "in_person" && showroom.addressLine && <p className="text-sm text-muted">{showroom.addressLine}</p>}
            </div>
            <Field label="Name" htmlFor="bk_name"><input id="bk_name" name="name" required autoComplete="name" className="input" /></Field>
            <Field label="Email" htmlFor="bk_email"><input id="bk_email" name="email" type="email" autoComplete="email" className="input" required={type.location === "video"} /></Field>
            <Field label="Phone" htmlFor="bk_phone" hint={type.location === "phone" ? "We'll call you on this number." : "Email, phone or both, so we can confirm."}>
              <input id="bk_phone" name="phone" type="tel" autoComplete="tel" className="input" required={type.location === "phone"} />
            </Field>
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" name="sms_consent" className="mt-1 h-4 w-4 rounded border-border accent-accent" />
              <span>Text me about this appointment. Standard rates apply; reply STOP to opt out.</span>
            </label>
            <Field label="Anything we should know? (optional)" htmlFor="bk_note"><textarea id="bk_note" name="note" rows={3} className="input" /></Field>
            <button type="submit" className="btn btn-primary btn-block">Confirm booking</button>
          </form>
        </Card>
      ) : (
        <SlotPicker days={days} base={base} date={date} tz={tz} />
      )}
      <p className="text-xs text-muted">Times are shown in {zoneLabel(tz)}.</p>
    </div>
  );
}
