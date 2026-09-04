import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { StatusBadge } from "@/components/status-badge";
import { Timeline } from "@/components/timeline";
import { Badge, Card, Dl, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { customerProfile } from "@/lib/customers";
import { formatMoney } from "@/lib/format";
import { getShowroom } from "@/lib/showroom";
import { formatDateTime, formatLongDateFromLocal } from "@/lib/time";

export const metadata = { title: "Customer" };

const BOOKABLE = ["invited", "building", "ready"];

/** One person, every bike: orders grouped by Lightspeed customer, phone or email (see lib/customers). */
export default async function CustomerPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  await requireUser("staff");
  const showroom = await getShowroom(db);
  const profile = await customerProfile(db, showroom, decodeURIComponent(key));
  if (!profile) notFound();
  const tz = showroom.timezone;
  const active = profile.bikes.filter((b) => !["picked_up", "cancelled", "unassigned", "released"].includes(b.unit.status));
  const past = profile.bikes.filter((b) => !active.includes(b));
  const withoutUnit = profile.orders.filter((o) => !profile.bikes.some((b) => b.order.id === o.id));

  const bikeRow = (b: (typeof profile.bikes)[number]) => (
    <li key={b.unit.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div>
        <p className="font-medium">
          <Link className="hover:text-accent" href={`/app/units/${b.unit.id}`}>{b.unit.model}</Link>
          <span className="text-muted"> · {[b.unit.size, b.unit.colour].filter(Boolean).join(" · ")}{[b.unit.size, b.unit.colour].some(Boolean) && " · "}box {b.unit.boxTag}</span>
        </p>
        <p className="text-sm text-muted">
          {b.order.source} {b.order.orderRef} · received {formatDateTime(b.unit.receivedAt, tz)}
          {b.appointment && b.appointment.status === "booked" && <> · pickup {formatDateTime(b.appointment.startsAt, tz)}</>}
          {b.unit.pickedUpAt && <> · picked up {formatDateTime(b.unit.pickedUpAt, tz)}</>}
          {b.order.balanceCents > 0 && <> · <span className="text-warn">{formatMoney(b.order.balanceCents)} due</span></>}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <StatusBadge status={b.unit.status} />
        {BOOKABLE.includes(b.unit.status) && <Link href={`/app/book?unit=${b.unit.id}`} className="btn btn-primary btn-sm">Book</Link>}
        <Link href={`/app/units/${b.unit.id}`} className="btn btn-sm">Open</Link>
      </div>
    </li>
  );

  return (
    <div>
      <PageHeader
        title={profile.name}
        subtitle={<>{[profile.phone, profile.email].filter(Boolean).join(" · ") || "no contact details"}{profile.lsCustomerId && <> · <Badge>Lightspeed customer #{profile.lsCustomerId}</Badge></>}</>}
        action={profile.lsCustomerId ? <Link href={`/app/book?customerID=${profile.lsCustomerId}&new=1`} className="btn btn-primary">New pickup</Link> : <Link href="/app/book" className="btn btn-primary">New pickup</Link>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title={`Bikes in progress (${active.length})`}>
            {active.length === 0 ? <p className="text-sm text-muted">Nothing in the building for this customer.</p> : <ul className="divide-y divide-border">{active.map(bikeRow)}</ul>}
          </Card>
          {withoutUnit.length > 0 && (
            <Card title="Orders not received yet">
              <ul className="divide-y divide-border text-sm">
                {withoutUnit.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span><Link className="font-medium hover:text-accent" href={`/app/orders/${o.id}`}>{o.model}</Link> <span className="text-muted">· {o.source} {o.orderRef} · ordered {formatLongDateFromLocal(o.orderDate)}</span></span>
                    <span className="flex items-center gap-2"><StatusBadge status={o.status} /><Link href={`/app/arrivals?q=${encodeURIComponent(o.orderRef)}`} className="btn btn-sm">Receive</Link></span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {past.length > 0 && <Card title={`Past bikes (${past.length})`}><ul className="divide-y divide-border">{past.map(bikeRow)}</ul></Card>}
          <Card title="History"><Timeline events={profile.events} tz={tz} /></Card>
        </div>
        <div className="space-y-6">
          <Card title="Customer">
            <Dl items={[["Name", profile.name], ["Phone", profile.phone ?? "—"], ["Email", profile.email ?? "—"], ["Lightspeed", profile.lsCustomerId ? `#${profile.lsCustomerId}` : "not linked"], ["Orders", String(profile.orders.length)], ["Bikes", String(profile.bikes.length)]]} />
            <p className="mt-3 text-xs text-muted">Contact details are edited on each order; Kickstand groups orders by Lightspeed customer, phone or email.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
