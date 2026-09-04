import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { orders } from "@/db/schema";
import { StatusBadge } from "@/components/status-badge";
import { Timeline } from "@/components/timeline";
import { Card, Field, Flash, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { customerKey } from "@/lib/customers";
import { sp, type SearchParams } from "@/lib/flash";
import { orderTimeline, unitsForOrder } from "@/lib/queries";
import { getShowroom } from "@/lib/showroom";
import { formatDateTime, formatLongDateFromLocal } from "@/lib/time";
import { updateOrderAction } from "../../actions";

export const metadata = { title: "Order" };

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const { id } = await params;
  const q = await searchParams;
  await requireUser("staff");
  const showroom = await getShowroom(db);
  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order || order.showroomId !== showroom.id) notFound();
  const [units, events] = await Promise.all([unitsForOrder(db, order.id), orderTimeline(db, order.id)]);
  const tz = showroom.timezone;

  return (
    <div>
      <PageHeader title={order.customerName} subtitle={`${order.source} ${order.orderRef} · ordered ${formatLongDateFromLocal(order.orderDate)} · ${order.model} ${[order.size, order.colour].filter(Boolean).join(" · ")}`} action={<div className="flex items-center gap-3"><Link href={`/app/customers/${encodeURIComponent(customerKey(order))}`} className="btn btn-sm">View customer</Link><StatusBadge status={order.status} /></div>} />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Units">
            {units.length === 0 ? <p className="text-sm text-muted">No unit received for this order yet.</p> : (
              <ul className="divide-y divide-border text-sm">
                {units.map((u) => (
                  <li key={u.id} className="flex items-center justify-between py-2">
                    <span><Link className="font-medium hover:text-accent" href={`/app/units/${u.id}`}>box {u.boxTag}</Link> · received {formatDateTime(u.receivedAt, tz)}</span>
                    <StatusBadge status={u.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Timeline"><Timeline events={events} tz={tz} /></Card>
        </div>
        <Card title="Edit order">
          <form action={updateOrderAction.bind(null, order.id)} className="space-y-3">
            <Field label="Customer name" htmlFor="customer_name"><input id="customer_name" name="customer_name" defaultValue={order.customerName} required className="input" /></Field>
            <Field label="Email" htmlFor="customer_email"><input id="customer_email" name="customer_email" type="email" defaultValue={order.customerEmail ?? ""} className="input" /></Field>
            <Field label="Phone" htmlFor="customer_phone"><input id="customer_phone" name="customer_phone" defaultValue={order.customerPhone ?? ""} className="input" /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="sms_consent" defaultChecked={order.smsConsent} className="h-4 w-4" /> SMS consent</label>
            <Field label="Balance due ($)" htmlFor="balance"><input id="balance" name="balance" inputMode="decimal" defaultValue={(order.balanceCents / 100).toFixed(2)} className="input" /></Field>
            <Field label="Pickup terms" htmlFor="terms_version" hint="v1 orders are never charged storage or released without agreement.">
              <select id="terms_version" name="terms_version" defaultValue={String(order.termsVersion)} className="input">
                <option value="1">v1 — current terms</option>
                <option value="2">v2 — new pickup terms</option>
              </select>
            </Field>
            <Field label="Notes" htmlFor="notes"><textarea id="notes" name="notes" rows={3} defaultValue={order.notes ?? ""} className="input" /></Field>
            <button type="submit" className="btn btn-primary">Save</button>
          </form>
        </Card>
      </div>
    </div>
  );
}
