import Link from "next/link";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { appointments, orders, units } from "@/db/schema";
import { AutoSubmitSelect } from "@/components/auto-submit-select";
import { BulkSelect } from "@/components/bulk-select";
import { StatusBadge } from "@/components/status-badge";
import { Badge, Card, Flash, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { currentShowroom } from "@/lib/current-showroom";
import { customerKey, groupOrders } from "@/lib/customers";
import { sp, type SearchParams } from "@/lib/flash";
import { ordersOnOrder } from "@/lib/special-orders";
import { daysBetween, formatDateTime, formatShortDateFromLocal, toLocalDate } from "@/lib/time";
import { collectPartsAction, inviteOrdersAction, syncSpecialOrdersAction } from "../actions";

export const metadata = { title: "Parts & accessories" };
export const maxDuration = 60;

/**
 * Parts & accessories pickups — a separate world from bikes: no build, no work order, no capacity,
 * no reminders. Orders arrive from the Lightspeed special-order sync, are invited per customer, the
 * customer picks any slot, and the order disappears when Lightspeed completes it (or staff press Collected).
 */
export default async function PartsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const user = await requireUser("staff");
  const showroom = await currentShowroom(user);
  const tz = showroom.timezone;
  const now = new Date();
  const today = toLocalDate(now, tz);
  const text = (sp(q.q) ?? "").trim().toLowerCase();
  // Item dropdown (exact item name, qty suffix stripped) + free text, like the model filter on Bikes.
  const itemFilter = sp(q.item) ?? "";
  const itemName = (model: string) => model.replace(/\s×\d+$/, "");

  const [onOrderAll, inBuilding, booked] = await Promise.all([
    ordersOnOrder(db, showroom, "parts"),
    db.select({ unit: units, order: orders }).from(units).innerJoin(orders, eq(orders.id, units.orderId)).where(and(eq(units.showroomId, showroom.id), eq(units.kind, "parts"), inArray(units.status, ["received", "invited", "booked", "building", "ready"]))),
    db.select().from(appointments).where(and(eq(appointments.showroomId, showroom.id), eq(appointments.status, "booked"))),
  ]);
  const apptByUnit = new Map(booked.map((a) => [a.unitId, a]));
  const match = (o: { customerName: string; model: string; orderRef: string; customerPhone: string | null }) =>
    !text || [o.customerName, o.model, o.orderRef, o.customerPhone].filter(Boolean).join(" ").toLowerCase().includes(text);
  const items = [...new Set(onOrderAll.map((o) => itemName(o.model)))].sort();
  const onOrder = onOrderAll.filter(match).filter((o) => !itemFilter || itemName(o.model) === itemFilter);
  const groups = groupOrders(onOrder); // one row per customer, all their (matching) items
  const building = inBuilding.filter((r) => match(r.order) && (!itemFilter || itemName(r.unit.model) === itemFilter));
  const params = new URLSearchParams();
  if (text) params.set("q", text);
  if (itemFilter) params.set("item", itemFilter);
  const RETURN = `/app/parts${params.toString() ? `?${params}` : ""}`;

  return (
    <div>
      <PageHeader
        title="Parts & accessories"
        subtitle={`${building.length} waiting for pickup · ${onOrderAll.length} on order · ${showroom.name}`}
        action={
          <div className="flex gap-2">
            {!!showroom.settings.lightspeed.shop_id && <form action={syncSpecialOrdersAction.bind(null, RETURN)}><button type="submit" className="btn btn-sm">Sync from Lightspeed</button></form>}
          </div>
        }
      />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <form action="/app/parts" className="mb-4 flex flex-wrap items-center gap-2">
        <AutoSubmitSelect name="item" defaultValue={itemFilter} className="input h-8 w-auto max-w-[24rem] py-0 text-sm" ariaLabel="Item">
          <option value="">All items</option>
          {items.map((m) => <option key={m} value={m}>{m} ({onOrderAll.filter((o) => itemName(o.model) === m).length})</option>)}
        </AutoSubmitSelect>
        <input name="q" defaultValue={text} placeholder="Customer, item or sale #" className="input h-8 w-64 text-sm" />
        <button type="submit" className="btn btn-sm">Filter</button>
        {(text || itemFilter) && <Link href="/app/parts" className="btn btn-sm">Clear</Link>}
      </form>

      <Card title={`Waiting for pickup (${building.length})`} className="mb-6">
        {building.length === 0 ? <p className="text-sm text-muted">Nothing invited or booked. Invite customers from the list below.</p> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Customer</th><th>Items</th><th>Status</th><th>Pickup</th><th></th></tr></thead>
              <tbody>
                {building.map(({ unit, order }) => {
                  const a = apptByUnit.get(unit.id);
                  return (
                    <tr key={unit.id}>
                      <td><Link href={`/app/customers/${encodeURIComponent(customerKey(order))}`} className="font-medium hover:text-accent">{order.customerName}</Link><p className="text-xs text-muted">{order.customerPhone ?? order.customerEmail ?? ""}</p></td>
                      <td>{unit.model}<p className="text-xs text-muted">{order.source} {order.orderRef}</p></td>
                      <td><StatusBadge status={unit.status} /></td>
                      <td className="text-sm">{a ? formatDateTime(a.startsAt, tz) : <span className="text-muted">Not booked · any slot</span>}</td>
                      <td className="text-right">
                        <div className="flex justify-end gap-1">
                          {!a && <Link href={`/app/book?unit=${unit.id}`} className="btn btn-sm">Book</Link>}
                          <form action={collectPartsAction.bind(null, unit.id, RETURN)}><button type="submit" className="btn btn-primary btn-sm">Collected</button></form>
                          <Link href={`/app/units/${unit.id}`} className="btn btn-sm">Open</Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`On order — not arrived yet (${onOrderAll.length}${onOrder.length !== onOrderAll.length ? `, showing ${onOrder.length}` : ""})`}>
        {onOrder.length === 0 ? (
          <p className="text-sm text-muted">{onOrderAll.length === 0 ? "No open parts & accessories special orders. They sync from Lightspeed every hour." : "Nothing matches this filter."}</p>
        ) : (
          <>
            <form id="onorder" action={inviteOrdersAction.bind(null, RETURN)} className="mb-3 flex flex-wrap items-center gap-3">
              <BulkSelect total={groups.length} name="order_ids" label="Select customers to invite" />
              <div className="ml-auto flex items-center gap-2">
                <span className="text-xs text-muted">One text per customer listing all their items; they pick any slot.</span>
                <button type="submit" className="btn btn-primary btn-sm">Send invites</button>
              </div>
            </form>
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th className="w-8"></th><th>Customer</th><th>Items</th><th>Ordered</th><th></th></tr></thead>
                <tbody>
                  {groups.map((group) => {
                    const primary = group[0];
                    const ids = group.map((o) => o.id);
                    const oldest = group.map((o) => o.orderDate).sort()[0];
                    return (
                      <tr key={primary.id}>
                        <td><input type="checkbox" name="order_ids" value={ids.join(",")} form="onorder" className="h-4 w-4" aria-label={`Select ${primary.customerName}`} /></td>
                        <td><Link href={`/app/customers/${encodeURIComponent(customerKey(primary))}`} className="font-medium hover:text-accent">{primary.customerName}</Link><p className="text-xs text-muted">{primary.customerPhone ?? primary.customerEmail ?? <span className="text-danger">no contact</span>}</p></td>
                        <td>
                          <ul className="text-sm">{group.map((o) => <li key={o.id}>{o.model} <span className="text-xs text-muted">· {o.orderRef}</span></li>)}</ul>
                          {group.length > 1 && <Badge>{group.length} items</Badge>}
                        </td>
                        <td className="text-xs text-muted">{formatShortDateFromLocal(oldest)} · {daysBetween(oldest, today)}d</td>
                        <td className="text-right">
                          <form action={inviteOrdersAction.bind(null, RETURN)}>{ids.map((id) => <input key={id} type="hidden" name="order_ids" value={id} />)}<button type="submit" className="btn btn-sm" disabled={!primary.customerEmail && !primary.customerPhone}>Invite</button></form>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
      <p className="mt-4 text-xs text-muted">Parts orders leave this page when Lightspeed completes the special order (next sync) or when staff press Collected. No work order, no build time, no capacity limit.</p>
    </div>
  );
}
