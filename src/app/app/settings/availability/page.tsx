import Link from "next/link";
import { db } from "@/db/client";
import { HoursEditor } from "@/components/hours-editor";
import { Card, Flash, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { colorOf, ensureDefaultBookingTypes, ensureStoreHours, listBookingTypes } from "@/lib/booking-types";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { setStoreHoursAction } from "../../actions";

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
