import Link from "next/link";
import { db } from "@/db/client";
import { HoursEditor } from "@/components/hours-editor";
import { Card, Flash, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { colorOf, ensureDefaultBookingTypes, ensureStoreHours, listBookingTypes } from "@/lib/booking-types";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { bookingsOnClosedDays, listClosedDays } from "@/lib/closed-days";
import { saskatchewanHolidays } from "@/lib/holidays";
import { formatLongDateFromLocal, formatTime, toLocalDate } from "@/lib/time";
import { addClosedDayAction, addSaskatchewanHolidaysAction, removeClosedDayAction, setStoreHoursAction } from "../../actions";

export const metadata = { title: "Availability" };

/**
 * The store's weekly hours for bookings ("Manage availability" in Calendly): set once here, used by every
 * booking type on "Store hours". A type with custom hours keeps its own. Bike pickups keep Settings › Capacity.
 */
export default async function AvailabilityPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const user = await requireUser("manager");
  const showroom = await currentShowroom(user);
  await ensureDefaultBookingTypes(db, showroom);
  const hours = await ensureStoreHours(db, showroom);
  const types = (await listBookingTypes(db, showroom.id)).filter((t) => t.kind === "standard");
  const following = types.filter((t) => t.useStoreHours);
  const custom = types.filter((t) => !t.useStoreHours);
  const today = toLocalDate(new Date(), showroom.timezone);
  const closed = await listClosedDays(db, showroom.id, today);
  const clashes = await bookingsOnClosedDays(db, showroom.id, closed.map((c) => c.date));
  const thisYear = Number(today.slice(0, 4));
  // Offer a year's holidays until every one still to come is already closed.
  const closedSet = new Set(closed.map((c) => c.date));
  const holidayYears = [thisYear, thisYear + 1].filter((y) => saskatchewanHolidays(y).some((h) => h.date >= today && !closedSet.has(h.date)));

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={`Availability · ${showroom.name}`}
        subtitle={`When customers can book at ${showroom.name}, in ${showroom.timezone.replace(/_/g, " ")} time. Every booking type on "Store hours" follows this.${showroom.kind === "showroom" ? " Bike pickups have their own times in Settings › Capacity." : ""}`}
      />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <form action={setStoreHoursAction} className="space-y-4">
        <HoursEditor hours={hours} />
        <p className="text-xs text-muted">Untick a day to close it. The second pair of times is optional, for a break in the day.</p>
        <button type="submit" className="btn btn-primary">Save availability</button>
      </form>
      <Card title="Closed days" className="mt-6">
        <p className="mb-3 text-sm text-muted">Dates {showroom.name} takes no bookings at all, such as stat holidays. They close every booking type{showroom.kind === "showroom" ? " and bike pickups" : ""}, whatever the weekly hours say.</p>
        {clashes.length > 0 && (
          <div className="mb-3 rounded-lg border border-warn bg-warn-soft p-3 text-sm">
            <p className="font-semibold">{clashes.length === 1 ? "1 booking is" : `${clashes.length} bookings are`} still on a closed day. Move or cancel {clashes.length === 1 ? "it" : "them"}:</p>
            <ul className="mt-1 space-y-0.5">
              {clashes.map((b) => <li key={b.id}><Link href={`/app/bookings/${b.id}`} className="underline">{b.customer}</Link> · {b.type} · {formatLongDateFromLocal(b.date)} {formatTime(b.startsAt, showroom.timezone)}</li>)}
            </ul>
          </div>
        )}
        {closed.length === 0 ? <p className="text-sm text-muted">None coming up.</p> : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {closed.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span><strong>{formatLongDateFromLocal(c.date)}</strong>{c.name ? <span className="text-muted"> · {c.name}</span> : null}</span>
                <form action={removeClosedDayAction.bind(null, c.id)}><button type="submit" className="btn btn-sm">Open this day</button></form>
              </li>
            ))}
          </ul>
        )}
        <form action={addClosedDayAction} className="mt-4 flex flex-wrap items-end gap-2">
          <label className="text-sm"><span className="mb-1 block text-xs text-muted">Date</span><input type="date" name="date" min={today} required className="input w-auto" /></label>
          <label className="flex-1 text-sm"><span className="mb-1 block text-xs text-muted">Name (optional)</span><input name="name" maxLength={80} placeholder="e.g. Staff training day" className="input" /></label>
          <button type="submit" className="btn">Close this day</button>
        </form>
        {holidayYears.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <span className="text-sm text-muted">Saskatchewan stat holidays:</span>
            {holidayYears.map((y) => (
              <form key={y} action={addSaskatchewanHolidaysAction}><input type="hidden" name="year" value={y} /><button type="submit" className="btn btn-sm">Add {y}</button></form>
            ))}
          </div>
        )}
      </Card>
      <Card title="Which types use it" className="mt-6">
        <ul className="space-y-1 text-sm">
          {following.map((t) => <li key={t.id} className="flex items-center gap-2"><span aria-hidden="true" className="h-3 w-3 rounded-full" style={{ background: colorOf(t.color).hex }} />{t.name}</li>)}
          {following.length === 0 && <li className="text-muted">None. Every type has custom hours.</li>}
        </ul>
        {custom.length > 0 && <p className="mt-3 text-xs text-muted">Own hours: {custom.map((t) => t.name).join(", ")}. Change them in <Link href="/app/settings/booking-types" className="underline">Booking types</Link>.</p>}
      </Card>
    </div>
  );
}
