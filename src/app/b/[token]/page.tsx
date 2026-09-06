import Link from "next/link";
import { db } from "@/db/client";
import { Alert, Card, Dl, LinkButton } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import { sp, type SearchParams } from "@/lib/flash";
import { appointmentHistory, getUnitByToken } from "@/lib/queries";
import { visitMates } from "@/lib/units";
import { getShowroom, getShowroomById } from "@/lib/showroom";
import { storageDueCents, storageEnabledFor } from "@/lib/storage";
import { formatDateTime, formatLongDate, formatTime } from "@/lib/time";
import { InvalidToken } from "./invalid";

export const metadata = { title: "Your bike" };

const OK_TEXT: Record<string, string> = {
  booked: "You're booked. We've sent a confirmation with the details.",
  rescheduled: "Your pickup has been moved. We've sent an updated confirmation.",
  rescheduled_late: "Your pickup has been moved. Because the change was inside 24 hours it counts as a missed pickup. We've sent an updated confirmation.",
  cancelled: "Your pickup is cancelled. Your order stays reserved — book a new time below.",
  cancelled_late: "Your pickup is cancelled. Because it was inside 24 hours it counts as a missed pickup. Your order stays reserved — book a new time below.",
  deferred: "Done — your order is now reserved from our next shipment.",
};

export default async function LandingPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<SearchParams> }) {
  const { token } = await params;
  const q = await searchParams;
  const view = await getUnitByToken(db, token);
  if (!view) return <InvalidToken showroom={await getShowroom(db)} />;
  // The bike's own showroom — multi-store safe, whatever DEFAULT_SHOWROOM says.
  const showroom = await getShowroomById(db, view.unit.showroomId);
  const { unit, order, appointment } = view;
  const tz = showroom.timezone;
  const s = showroom.settings;
  const now = new Date();
  const ok = sp(q.ok);
  const storageOn = storageEnabledFor(s, order?.termsVersion ?? 1);
  const due = storageDueCents(unit, order?.termsVersion ?? 1, s, now, tz);

  const bikeCard = (
    <Card>
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{unit.kind === "parts" ? "Your order" : "Your bike"}</p>
      <p className="mt-1 text-lg font-semibold">{unit.model}</p>
      <p className="text-sm text-muted">{[unit.size, unit.colour].filter(Boolean).join(" · ")}</p>
      <div className="mt-3">
        <Dl
          items={[
            ["Showroom", `${showroom.name}, ${showroom.addressLine}`],
            ...(order?.paymentStatus === "deposit" && order.balanceCents > 0 ? ([["Balance due at pickup", formatMoney(order.balanceCents)]] as [string, string][]) : []),
          ]}
        />
      </div>
    </Card>
  );

  const flash = ok && OK_TEXT[ok] ? <Alert tone="ok">{OK_TEXT[ok]}</Alert> : null;

  if (unit.status === "picked_up") {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Enjoy the ride</h1>
        <p className="text-sm text-muted">You picked up your {unit.model} on {unit.pickedUpAt ? formatLongDate(unit.pickedUpAt, tz) : "—"}. Thanks for riding Biktrix.</p>
        {bikeCard}
      </div>
    );
  }

  if (unit.status === "unassigned" || unit.status === "received" || !order || order.status === "deferred") {
    return (
      <div className="space-y-4">
        {flash}
        <h1 className="text-2xl font-semibold">Reserved from our next shipment</h1>
        <p className="text-sm text-muted">Your order keeps its place in line. We&apos;ll send you a new invitation the moment your bike lands at {showroom.name}.</p>
        <Card>
          <p className="text-lg font-semibold">{unit.model}</p>
          <p className="text-sm text-muted">{[unit.size, unit.colour].filter(Boolean).join(" · ")}</p>
        </Card>
      </div>
    );
  }

  const mates = appointment ? await visitMates(db, appointment) : [];
  if (appointment) {
    const built = unit.status === "building" || unit.status === "ready";
    return (
      <div className="space-y-4">
        {flash}
        <h1 className="text-2xl font-semibold">You&apos;re booked</h1>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Pickup</p>
          <p className="mt-1 text-xl font-semibold">{formatLongDate(appointment.startsAt, tz)}</p>
          <p className="text-lg">{formatTime(appointment.startsAt, tz)} – {formatTime(appointment.endsAt, tz)}</p>
          {mates.length > 0 && <p className="mt-1 text-sm text-muted">Collecting {mates.length + 1} bikes: {[unit, ...mates].map((m) => m.model).join(", ")}.</p>}
          <p className="mt-2 text-sm text-muted">{showroom.addressLine}</p>
          {built && <p className="mt-3 rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">Your bike is built and charging.</p>}
          {due > 0 && <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">Storage of {formatMoney(due)} is payable at pickup.</p>}
          <div className="mt-4 grid grid-cols-2 gap-2">
            <LinkButton href={`/b/${token}/book?reschedule=1`}>Reschedule</LinkButton>
            <LinkButton href={`/b/${token}/manage?confirm=cancel`}>Cancel</LinkButton>
          </div>
          <a className="mt-3 block text-center text-sm text-accent underline" href={`/api/ics/${appointment.id}`}>Add to calendar (.ics)</a>
        </Card>
        <Card title="What to bring">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            <li>A copy of your order confirmation (on your phone is fine) and photo ID.</li>
            {unit.kind === "parts" ? <li>Just a few minutes at the counter.</li> : <li>About 45 minutes for fitting and a display walkthrough.</li>}
            {order.balanceCents > 0 && <li>Your balance of {formatMoney(order.balanceCents)} is due at handover.</li>}
          </ul>
        </Card>
        {bikeCard}
        <p className="text-xs text-muted">Changes are free until {s.reschedule_cutoff_hours} hours before your slot; inside that window a change counts as a missed pickup.</p>
      </div>
    );
  }

  if (unit.status === "ready" || unit.status === "building") {
    // A built bike with no booking: only call it a missed pickup when the last appointment was one.
    const last = (await appointmentHistory(db, unit.id))[0];
    const missed = last?.status === "no_show";
    return (
      <div className="space-y-4">
        {flash}
        <h1 className="text-2xl font-semibold">{missed ? "You missed your pickup" : "Pick a new time"}</h1>
        <p className="text-sm text-muted">Your bike is built and waiting at {showroom.name}. Book a new time and we&apos;ll have it charged for you.</p>
        {unit.storageFrom && storageOn && (
          <Alert tone="warn">Storage of {formatMoney(s.storage_rate_cents)} per day applies from {formatLongDate(unit.storageFrom, tz)} (max {formatMoney(s.storage_cap_cents)}). Due now: {formatMoney(due)}.</Alert>
        )}
        <LinkButton href={`/b/${token}/book`} primary className="btn-block">Book a new time</LinkButton>
        {bikeCard}
      </div>
    );
  }

  // invited
  const overdue = !!unit.pickupBy && now > unit.pickupBy;
  return (
    <div className="space-y-4">
      {flash}
      <h1 className="text-2xl font-semibold">Your {unit.model} is here</h1>
      <p className="text-sm text-muted">
        It arrived at {showroom.name}. Book a pickup time and we&apos;ll build, charge and fit it for you. We hold it free until{" "}
        <strong className="text-foreground">{unit.pickupBy ? formatLongDate(unit.pickupBy, tz) : "—"}</strong>.
      </p>
      {overdue && storageOn && (
        <Alert tone="warn">Your free hold has ended. Storage of {formatMoney(s.storage_rate_cents)} per day applies (max {formatMoney(s.storage_cap_cents)}); due now: {formatMoney(due)}.</Alert>
      )}
      <LinkButton href={`/b/${token}/book`} primary className="btn-block">Book your pickup</LinkButton>
      {s.defer_enabled && (
        <p className="text-center text-sm">
          Can&apos;t make it in time?{" "}
          <Link className="text-accent underline" href={`/b/${token}/manage`}>See your options</Link>
        </p>
      )}
      {bikeCard}
      <p className="text-xs text-muted">Invited {unit.invitedAt ? formatDateTime(unit.invitedAt, tz) : ""}.</p>
    </div>
  );
}
