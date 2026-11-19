import Link from "next/link";
import { db } from "@/db/client";
import { Alert, Badge, Card } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { LOCATION_LABEL, colorOf, type BookingLocation } from "@/lib/booking-types";
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
  // In person: the store's own time (that's where they'll be); calls: the customer's zone.
  const inPerson = type.location === "in_person";
  const tz = inPerson ? showroom.timezone : viewZone(sp(q.tz), showroom.timezone);
  const tzq = tz === showroom.timezone ? "" : `?tz=${encodeURIComponent(tz)}`;
  const active = booking.status === "booked" && booking.startsAt > new Date();
  const ok = sp(q.ok);
  const error = sp(q.error);
  const where = type.location === "in_person"
    ? showroom.addressLine
    : type.location === "phone"
      ? `We'll call you${booking.customerPhone ? ` at ${booking.customerPhone}` : ""}.`
      : LOCATION_LABEL[type.location as BookingLocation];

  if (ok === "booked" && active) {
    const accent = colorOf(type.color).hex;
    const first = booking.customerName.trim().split(/\s+/)[0];
    const remote = type.location === "phone" || type.location === "video";
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        {!inPerson && <ZoneAuto storeTz={showroom.timezone} />}
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <RideBanner accent={accent} />
          <div className={`grid gap-8 p-6 sm:p-8 ${remote ? "md:grid-cols-[minmax(0,1fr)_300px]" : ""}`}>
            <div className="space-y-4">
              <h1 className="text-3xl font-extrabold leading-tight tracking-tight">
                You&apos;re on the calendar.
                {first && <><br /><span style={{ color: accent }}>{remote ? "Talk soon" : "See you soon"}, {first}.</span></>}
              </h1>
              <div className="space-y-1">
                <p><span className="font-semibold">{formatLongDate(booking.startsAt, tz)}, {formatTime(booking.startsAt, tz)}</span> <span className="text-sm text-muted">({zoneLabel(tz)})</span></p>
                <p className="text-sm text-muted">{type.name} · {showroom.name}</p>
                {where && type.location !== "video" && <p className="text-sm text-muted">{where}</p>}
                <p className="text-sm text-muted">A confirmation is on its way.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <a href={`/book/m/${token}/ics`} className="btn text-white" style={{ background: accent, borderColor: accent }}>Add to calendar</a>
                <Link href={`/book/m/${token}/reschedule${tzq}`} className="btn">Change time</Link>
              </div>
              <form action={cancelTypeAction.bind(null, token)} className="text-sm text-muted">
                Can&apos;t make it? <ConfirmButton className="text-accent underline" message="Cancel this booking?">Cancel booking</ConfirmButton>
              </form>
            </div>
            {remote && (
              <div className="space-y-3 self-start rounded-xl bg-background p-5">
                <p className="text-xs font-bold uppercase tracking-widest" style={{ color: accent }}>Before the call</p>
                {BEFORE_CALL.map((tip, i) => (
                  <p key={i} className="flex gap-3 text-sm leading-relaxed"><span className="font-extrabold" style={{ color: accent }}>{i + 1}</span>{tip}</p>
                ))}
              </div>
            )}
          </div>
        </div>
        {showroom.phone && <p className="text-xs text-muted">Questions? Call {showroom.name} at {showroom.phone}.</p>}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      {!inPerson && <ZoneAuto storeTz={showroom.timezone} />}
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

/** Tips on the just-booked screen for phone and video calls (the online showroom's calls are all about choosing a bike). */
const BEFORE_CALL = [
  "Think about where you'll ride most: commuting, gravel, trails, snow, hauling.",
  "Know your height, and your inseam if it's handy.",
  "Have a rough budget in mind. Not sure yet? That's what the call is for.",
];

/** A little bike rolls in over a tire track on the just-booked screen. Plays once; reduced motion shows it parked. */
function RideBanner({ accent }: { accent: string }) {
  return (
    <div className="ride-banner relative h-20 overflow-hidden" style={{ background: `color-mix(in srgb, ${accent} 10%, white)` }} aria-hidden="true">
      <svg className="ride-track absolute bottom-2.5 left-0 h-2.5 w-full">
        <defs>
          <pattern id="ride-tread" width="14" height="10" patternUnits="userSpaceOnUse">
            <path d="M2 1 L8 5 L2 9" stroke={`color-mix(in srgb, ${accent} 35%, white)`} strokeWidth="2.5" fill="none" strokeLinecap="round" />
          </pattern>
        </defs>
        <rect width="100%" height="10" fill="url(#ride-tread)" />
      </svg>
      <svg className="ride-bike absolute bottom-1.5" width="76" height="47" viewBox="0 0 84 52" fill="none" stroke="#17181A" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <g className="ride-wheel"><circle cx="17" cy="35" r="14" /><path d="M17 21v28M3 35h28" strokeWidth="1.2" /></g>
        <g className="ride-wheel"><circle cx="67" cy="35" r="14" /><path d="M67 21v28M53 35h28" strokeWidth="1.2" /></g>
        <path d="M17 35 L32 17 L56 17 L67 35 M32 17 L42 35 L56 17 M42 35 L17 35" />
        <path d="M29 11 h9 M56 17 L53 8 h8" />
        <rect x="35" y="21" width="14" height="7" rx="2" fill={accent} stroke="none" />
      </svg>
    </div>
  );
}
