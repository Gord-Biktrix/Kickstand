import Link from "next/link";
import { db } from "@/db/client";
import { Alert, Card, LinkButton } from "@/components/ui";
import { BOOKING_ERROR_TEXT, type BookingErrorCode } from "@/lib/booking";
import { formatMoney } from "@/lib/format";
import { sp, type SearchParams } from "@/lib/flash";
import { getUnitByToken } from "@/lib/queries";
import { getShowroom, getShowroomById } from "@/lib/showroom";
import { addHours, formatLongDate, formatTime } from "@/lib/time";
import { cancelAction, deferAction } from "../actions";
import { InvalidToken } from "../invalid";

export const metadata = { title: "Manage your pickup" };

export default async function ManagePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<SearchParams> }) {
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
  const confirm = sp(q.confirm);
  const errorRaw = sp(q.error);
  const errorText = errorRaw ? BOOKING_ERROR_TEXT[errorRaw as BookingErrorCode] ?? errorRaw : null;
  const canDefer = s.defer_enabled && (unit.status === "invited" || unit.status === "booked") && order?.status === "open";
  const insideCutoff = appointment ? now > addHours(appointment.startsAt, -s.reschedule_cutoff_hours) : false;

  return (
    <div className="space-y-4">
      <div>
        <Link href={`/b/${token}`} className="text-sm text-accent underline">← Back</Link>
        <h1 className="mt-2 text-2xl font-semibold">Manage your pickup</h1>
      </div>
      {errorText && <Alert tone="danger">{errorText}</Alert>}

      {appointment && (
        <Card title="Your booking">
          <p className="text-lg font-semibold">{formatLongDate(appointment.startsAt, tz)}</p>
          <p>{formatTime(appointment.startsAt, tz)} – {formatTime(appointment.endsAt, tz)}</p>
          {insideCutoff && (
            <div className="mt-3"><Alert tone="warn">Your slot is less than {s.reschedule_cutoff_hours} hours away. Changing or cancelling now counts as a missed pickup.</Alert></div>
          )}
          {confirm === "cancel" ? (
            <form action={cancelAction.bind(null, token)} className="mt-4 space-y-3">
              <p className="text-sm">Cancel this pickup? Your bike stays reserved and you can book a new time before {unit.pickupBy ? formatLongDate(unit.pickupBy, tz) : "your hold ends"}.</p>
              <div className="grid grid-cols-2 gap-2">
                <Link href={`/b/${token}/manage`} className="btn">Keep it</Link>
                <button type="submit" className="btn btn-danger">Yes, cancel</button>
              </div>
            </form>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-2">
              <LinkButton href={`/b/${token}/book?reschedule=1`} primary>Reschedule</LinkButton>
              <LinkButton href={`/b/${token}/manage?confirm=cancel`}>Cancel</LinkButton>
            </div>
          )}
        </Card>
      )}

      {!appointment && ["invited", "ready", "building"].includes(unit.status) && (
        <Card title="Book a pickup">
          <p className="mb-3 text-sm text-muted">You don&apos;t have a pickup booked yet.</p>
          <LinkButton href={`/b/${token}/book`} primary className="btn-block">Pick a time</LinkButton>
        </Card>
      )}

      {canDefer && (
        <Card title="Can't make it in time?">
          <div id="defer" />
          <p className="text-sm text-muted">
            Move your order to our next shipment at no charge. You keep your place in line, this bike goes to the next customer waiting, and we&apos;ll invite you again when yours lands.
            {appointment ? " Any booked pickup is cancelled without penalty." : ""}
          </p>
          {confirm === "defer" ? (
            <form action={deferAction.bind(null, token)} className="mt-4 space-y-3">
              <p className="text-sm font-medium">Move to the next shipment?</p>
              <div className="grid grid-cols-2 gap-2">
                <Link href={`/b/${token}/manage`} className="btn">Not now</Link>
                <button type="submit" className="btn btn-primary">Yes, move my order</button>
              </div>
            </form>
          ) : (
            <div className="mt-4"><LinkButton href={`/b/${token}/manage?confirm=defer#defer`}>Move to next shipment</LinkButton></div>
          )}
        </Card>
      )}

      {unit.pickupBy && (
        <p className="text-xs text-muted">
          Free hold until {formatLongDate(unit.pickupBy, tz)}.
          {s.storage_fee_enabled && (order?.termsVersion ?? 1) >= 2 ? ` After that, storage is ${formatMoney(s.storage_rate_cents)} per day (max ${formatMoney(s.storage_cap_cents)}), payable at pickup.` : ""}
        </p>
      )}
    </div>
  );
}
