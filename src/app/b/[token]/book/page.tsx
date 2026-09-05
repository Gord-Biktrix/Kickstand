import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { Alert, Card } from "@/components/ui";
import { getAvailability } from "@/lib/availability";
import { BOOKING_ERROR_TEXT, type BookingErrorCode } from "@/lib/booking";
import type { DaySummary } from "@/lib/capacity";
import { formatMoney } from "@/lib/format";
import { sp, type SearchParams } from "@/lib/flash";
import { getUnitByToken } from "@/lib/queries";
import { getShowroom, getShowroomById } from "@/lib/showroom";
import { addHours, addLocalDays, formatDateTime, formatLongDateFromLocal, formatShortDateFromLocal, formatTime, weekdayOf } from "@/lib/time";
import { bookAction } from "../actions";
import { InvalidToken } from "../invalid";

export const metadata = { title: "Pick a time" };

function mondayOf(date: string) {
  return addLocalDays(date, -((weekdayOf(date) + 6) % 7));
}

export default async function BookPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<SearchParams> }) {
  const { token } = await params;
  const q = await searchParams;
  const view = await getUnitByToken(db, token);
  if (!view) return <InvalidToken showroom={await getShowroom(db)} />;
  // The bike's own showroom — multi-store safe, whatever DEFAULT_SHOWROOM says.
  const showroom = await getShowroomById(db, view.unit.showroomId);
  const { unit, order, appointment } = view;
  const reschedule = sp(q.reschedule) === "1";
  if (!["invited", "booked", "building", "ready"].includes(unit.status)) redirect(`/b/${token}`);
  if (appointment && !reschedule) redirect(`/b/${token}/manage`);
  if (!appointment && reschedule) redirect(`/b/${token}/book`);

  const tz = showroom.timezone;
  const s = showroom.settings;
  const days = await getAvailability(db, { showroom, unit, order });
  const openDays = days.filter((d) => !d.day.closed && !d.beyondHorizon);
  const selectedDate = sp(q.date);
  const selectedTime = sp(q.time);
  const errorCode = sp(q.error) as BookingErrorCode | undefined;
  const qs = reschedule ? "reschedule=1&" : "";
  const base = `/b/${token}/book?${qs}`;

  // R8: moving a slot inside the cutoff counts as a missed pickup — say so before the customer confirms.
  const insideCutoff = reschedule && appointment ? new Date() > addHours(appointment.startsAt, -s.reschedule_cutoff_hours) : false;
  const selected: DaySummary | undefined = selectedDate ? openDays.find((d) => d.date === selectedDate) : undefined;
  const slot = selected && selectedTime ? selected.slots.find((sl) => sl.startLocal === selectedTime) : undefined;

  const weeks = new Map<string, DaySummary[]>();
  for (const d of openDays) {
    const k = mondayOf(d.date);
    weeks.set(k, [...(weeks.get(k) ?? []), d]);
  }

  return (
    <div className="space-y-4">
      <div>
        <Link href={selected ? base : `/b/${token}`} className="text-sm text-accent underline">← Back</Link>
        <h1 className="mt-2 text-2xl font-semibold">{reschedule ? "Pick a new time" : "Pick a time"}</h1>
        <p className="mt-1 text-sm text-muted">
          {unit.model} · {showroom.name}. Pickups take about 45 minutes. We need {s.min_lead_hours} hours&apos; notice to build your bike.
        </p>
      </div>
      {errorCode && BOOKING_ERROR_TEXT[errorCode] && <Alert tone="danger">{BOOKING_ERROR_TEXT[errorCode]}</Alert>}

      {slot ? (
        <Card title="Confirm your pickup">
          {!slot.available ? (
            <Alert tone="danger">That time is no longer available. <Link className="underline" href={`${base}date=${selected!.date}`}>Choose another</Link>.</Alert>
          ) : (
            <form action={bookAction.bind(null, token)} className="space-y-4">
              <input type="hidden" name="starts_at" value={slot.startsAt.toISOString()} />
              {reschedule && <input type="hidden" name="reschedule" value="1" />}
              <div>
                {reschedule && appointment && <p className="text-sm text-muted">Moving from {formatDateTime(appointment.startsAt, tz)} to:</p>}
                <p className="text-xl font-semibold">{formatLongDateFromLocal(selected!.date)}</p>
                <p className="text-lg">{formatTime(slot.startsAt, tz)} – {formatTime(slot.endsAt, tz)}</p>
                <p className="mt-1 text-sm text-muted">{showroom.addressLine}</p>
              </div>
              {insideCutoff && (
                <Alert tone="warn">
                  Your current slot is less than {s.reschedule_cutoff_hours} hours away, so this change will be recorded as a missed pickup. Your bike stays reserved.
                </Alert>
              )}
              {slot.storageApplies && slot.storageEstimateCents > 0 && (
                <Alert tone="warn">
                  This date is after your free hold ends. Storage of about <strong>{formatMoney(slot.storageEstimateCents)}</strong> will be payable at pickup ({formatMoney(s.storage_rate_cents)}/day, max {formatMoney(s.storage_cap_cents)}).
                </Alert>
              )}
              {order && order.balanceCents > 0 && <p className="text-sm text-muted">Balance due at handover: {formatMoney(order.balanceCents)}.</p>}
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" name="sms_consent" defaultChecked={order?.smsConsent ?? false} className="mt-1 h-4 w-4 rounded border-border accent-accent" />
                <span>Text me reminders about this pickup{order?.customerPhone ? ` at ${order.customerPhone}` : ""}. Standard rates apply; reply STOP to opt out.</span>
              </label>
              <p className="text-xs text-muted">
                You can reschedule or cancel free of charge up to {s.reschedule_cutoff_hours} hours before your slot. Inside that window a change is recorded as a missed pickup.
              </p>
              <button className="btn btn-primary btn-block" type="submit">{reschedule ? "Confirm new time" : "Confirm pickup"}</button>
            </form>
          )}
        </Card>
      ) : selected ? (
        <Card title={formatLongDateFromLocal(selected.date)}>
          <p className="mb-3 text-sm text-muted">{selected.remaining} of {selected.day.capacity} pickups left this day.</p>
          {selected.storageEstimateCents > 0 && (
            <div className="mb-3"><Alert tone="warn">Storage of about {formatMoney(selected.storageEstimateCents)} applies for a pickup on this day.</Alert></div>
          )}
          <ul className="grid grid-cols-2 gap-2" aria-label="Available times">
            {selected.slots.map((sl) => (
              <li key={sl.startLocal}>
                {sl.available ? (
                  <Link href={`${base}date=${selected.date}&time=${sl.startLocal}`} className="btn w-full">
                    {formatTime(sl.startsAt, tz)}
                  </Link>
                ) : (
                  <span aria-disabled="true" className="btn w-full cursor-not-allowed opacity-50">
                    {formatTime(sl.startsAt, tz)}
                    <span className="sr-only"> — {sl.reason === "too_early" ? "too soon" : "taken"}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">Greyed-out times are taken or too soon.</p>
        </Card>
      ) : (
        <div className="space-y-4">
          {openDays.length === 0 && <Alert tone="warn">No open days in your booking window. Please call {showroom.phone ?? "the showroom"}.</Alert>}
          {[...weeks.entries()].map(([monday, list]) => (
            <Card key={monday} title={`Week of ${formatShortDateFromLocal(monday)}`}>
              <ul className="divide-y divide-border" aria-label="Open days">
                {list.map((d) => {
                  const full = !d.bookable;
                  const label = d.reason === "too_soon" ? "Too soon" : d.reason === "full" ? "Full" : d.reason === "closed" ? "Closed" : `${d.remaining} of ${d.day.capacity} left`;
                  const inner = (
                    <>
                      <span className="font-medium">{formatShortDateFromLocal(d.date)}</span>
                      <span className="ml-auto flex items-center gap-2 text-xs">
                        {d.storageEstimateCents > 0 && <span className="badge border-warn/30 bg-warn-soft text-warn">storage {formatMoney(d.storageEstimateCents)}</span>}
                        <span className={full ? "text-muted" : "text-ok"}>{label}</span>
                      </span>
                    </>
                  );
                  return (
                    <li key={d.date}>
                      {full ? (
                        <div aria-disabled="true" className="flex items-center gap-3 py-3 text-sm opacity-60">{inner}</div>
                      ) : (
                        <Link href={`${base}date=${d.date}`} className="flex items-center gap-3 py-3 text-sm hover:text-accent focus-visible:outline-2 focus-visible:outline-accent">{inner}</Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
