import Link from "next/link";
import { db } from "@/db/client";
import { StatusBadge } from "@/components/status-badge";
import { Badge, Card, Empty, Field, Flash, PageHeader } from "@/components/ui";
import { hasRole, requireUser } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import { sp, type SearchParams } from "@/lib/flash";
import { receivedNotInvited, searchOrders, unassignedUnits } from "@/lib/queries";
import { getShowroom } from "@/lib/showroom";
import { formatDateTime, formatLongDateFromLocal, toLocalDate } from "@/lib/time";
import { defaultTermsVersion, waitlistFor } from "@/lib/units";
import { attachUnitAction, createOrderAction, inviteAllAction, inviteUnitAction, receiveUnitAction } from "../actions";

export const metadata = { title: "Arrivals" };

export default async function ArrivalsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const user = await requireUser("staff");
  const showroom = await getShowroom(db);
  const query = sp(q.q) ?? "";
  const [results, pending, unassigned] = await Promise.all([searchOrders(db, showroom, query, 25), receivedNotInvited(db, showroom), unassignedUnits(db, showroom)]);
  const manager = hasRole(user.role, "manager");
  const unassignedMatches = manager ? await Promise.all(unassigned.map((u) => waitlistFor(db, showroom.id, u))) : unassigned.map(() => []);
  const today = toLocalDate(new Date(), showroom.timezone);
  const deferredFirst = [...results].sort((a, b) => (a.order.status === "deferred" ? -1 : 0) - (b.order.status === "deferred" ? -1 : 0));

  return (
    <div>
      <PageHeader title="Arrivals" subtitle="Receive a box, tag it to its order, then send the invite." />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <Card title="Find the order">
            <form className="flex gap-2" role="search">
              <input name="q" defaultValue={query} className="input" placeholder="Name, order #, phone, email or model" aria-label="Search orders" />
              <button className="btn" type="submit">Search</button>
            </form>
            <ul className="mt-4 divide-y divide-border">
              {deferredFirst.length === 0 && <li className="py-3 text-sm text-muted">{query ? "No open or deferred orders match." : "Type to search open orders, or add a new one below."}</li>}
              {deferredFirst.map(({ order, unit }) => (
                <li key={order.id} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">
                        <Link href={`/app/orders/${order.id}`} className="hover:text-accent">{order.customerName}</Link>
                        <span className="ml-2 text-xs text-muted">{order.source} {order.orderRef}</span>
                      </p>
                      <p className="text-sm">{order.model} · {[order.size, order.colour].filter(Boolean).join(" · ")}</p>
                      <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                        <StatusBadge status={order.status} />
                        {order.status === "deferred" && <Badge tone="warn">waiting since {order.deferredAt ? formatDateTime(order.deferredAt, showroom.timezone) : order.orderDate}</Badge>}
                        {order.paymentStatus === "deposit" && <Badge tone="warn">balance {formatMoney(order.balanceCents)}</Badge>}
                        <Badge tone="neutral">terms v{order.termsVersion}</Badge>
                      </div>
                    </div>
                    {unit ? (
                      <div className="text-right text-xs text-muted">
                        <p>Unit <Link className="underline" href={`/app/units/${unit.id}`}>{unit.boxTag}</Link></p>
                        <StatusBadge status={unit.status} />
                      </div>
                    ) : (
                      <form action={receiveUnitAction} className="flex items-end gap-2">
                        <input type="hidden" name="order_id" value={order.id} />
                        <input type="hidden" name="q" value={query} />
                        <Field label="Box tag (optional)" htmlFor={`tag-${order.id}`} hint={order.status === "deferred" ? "Receiving reopens this deferred order." : undefined}>
                          <input id={`tag-${order.id}`} name="box_tag" className="input w-40" placeholder={`blank = ${order.orderRef}`} />
                        </Field>
                        <button type="submit" className="btn btn-primary">Receive</button>
                      </form>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="New order">
            <details>
              <summary className="cursor-pointer text-sm text-accent">Add an order manually</summary>
              <form action={createOrderAction} className="mt-4 grid gap-3 sm:grid-cols-2">
                <Field label="Order ref" htmlFor="order_ref"><input id="order_ref" name="order_ref" required className="input" placeholder="LS-48213" /></Field>
                <Field label="Source" htmlFor="source">
                  <select id="source" name="source" className="input" defaultValue="lightspeed">
                    <option value="lightspeed">Lightspeed</option>
                    <option value="shopify">Shopify</option>
                    <option value="manual">Manual</option>
                  </select>
                </Field>
                <Field label="Customer name" htmlFor="customer_name"><input id="customer_name" name="customer_name" required className="input" /></Field>
                <Field label="Email" htmlFor="customer_email"><input id="customer_email" name="customer_email" type="email" className="input" /></Field>
                <Field label="Phone" htmlFor="customer_phone" hint="10 digits assumes +1"><input id="customer_phone" name="customer_phone" className="input" placeholder="604 555 0123" /></Field>
                <Field label="Model" htmlFor="model"><input id="model" name="model" required className="input" /></Field>
                <Field label="Size" htmlFor="size"><input id="size" name="size" className="input" /></Field>
                <Field label="Colour" htmlFor="colour"><input id="colour" name="colour" className="input" /></Field>
                <Field label="Order date" htmlFor="order_date"><input id="order_date" name="order_date" type="date" required className="input" defaultValue={today} /></Field>
                <Field label="Payment" htmlFor="payment_status">
                  <select id="payment_status" name="payment_status" className="input" defaultValue="paid">
                    <option value="paid">Paid in full</option>
                    <option value="deposit">Deposit — balance due</option>
                  </select>
                </Field>
                <Field label="Balance due ($)" htmlFor="balance"><input id="balance" name="balance" inputMode="decimal" className="input" placeholder="0.00" /></Field>
                <Field label="Pickup terms" htmlFor="terms_version" hint={`Defaults to v${defaultTermsVersion(showroom.settings, today)} for today's date${showroom.settings.terms_v2_effective_date ? ` (v2 from ${formatLongDateFromLocal(showroom.settings.terms_v2_effective_date)})` : ""}.`}>
                  <select id="terms_version" name="terms_version" className="input" defaultValue="">
                    <option value="">Default</option>
                    <option value="1">v1 — current terms (no storage, no release)</option>
                    <option value="2">v2 — new pickup terms</option>
                  </select>
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Notes" htmlFor="notes"><textarea id="notes" name="notes" rows={2} className="input" /></Field>
                </div>
                <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="sms_consent" className="h-4 w-4" /> Customer has consented to SMS reminders</label>
                <div className="sm:col-span-2"><button type="submit" className="btn btn-primary">Create order</button></div>
              </form>
            </details>
          </Card>

          {hasRole(user.role, "manager") && (
            <p className="text-xs text-muted">Importing existing pre-orders? <Link href="/app/settings/import" className="text-accent underline">Settings › Import</Link>.</p>
          )}
        </div>

        <Card
          title={`Received, not yet invited (${pending.length})`}
          action={
            pending.length > 1 ? (
              <form action={inviteAllAction}><button type="submit" className="btn btn-primary btn-sm">Invite all</button></form>
            ) : null
          }
        >
          {pending.length === 0 ? (
            <Empty>Nothing waiting. Receive a box on the left to start.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {pending.map(({ unit, order }) => (
                <li key={unit.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-medium"><Link href={`/app/units/${unit.id}`} className="hover:text-accent">{order?.customerName ?? "—"}</Link> <span className="text-xs text-muted">{order?.orderRef}</span></p>
                    <p className="text-sm">{unit.model} · {[unit.size, unit.colour].filter(Boolean).join(" · ")} · box {unit.boxTag}</p>
                    <p className="text-xs text-muted">Received {formatDateTime(unit.receivedAt, showroom.timezone)}{!order?.customerEmail && !order?.customerPhone ? " · no contact details — edit the order first" : ""}</p>
                  </div>
                  <form action={inviteUnitAction.bind(null, unit.id, "/app/arrivals")}>
                    <button type="submit" className="btn btn-primary btn-sm" disabled={!order?.customerEmail && !order?.customerPhone}>Invite</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {unassigned.length > 0 && (
          <Card title={`Unassigned boxes on hand (${unassigned.length})`} className="lg:col-start-2">
            <p className="mb-3 text-xs text-muted">Bikes on the shelf with no customer — detached after a defer or release. Attach one to a waiting order to restart its clock.</p>
            <ul className="divide-y divide-border">
              {unassigned.map((u, i) => {
                const matches = unassignedMatches[i];
                return (
                  <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div>
                      <p className="font-medium"><Link href={`/app/units/${u.id}`} className="hover:text-accent">{u.model}</Link> <span className="text-xs text-muted">box {u.boxTag}</span></p>
                      <p className="text-sm text-muted">{[u.size, u.colour].filter(Boolean).join(" · ")} · detached {formatDateTime(u.updatedAt, showroom.timezone)}</p>
                    </div>
                    {manager ? (
                      matches.length === 0 ? (
                        <p className="text-xs text-muted">No open or deferred order matches this model, size and colour.</p>
                      ) : (
                        <form action={attachUnitAction.bind(null, u.id, "/app/arrivals")} className="flex items-end gap-2">
                          <select name="order_id" className="input w-56" required aria-label="Waiting order">
                            {matches.map((o) => <option key={o.id} value={o.id}>{o.customerName} — {o.orderRef}{o.status === "deferred" ? " (deferred)" : ""}</option>)}
                          </select>
                          <button type="submit" className="btn btn-primary btn-sm">Attach and invite</button>
                        </form>
                      )
                    ) : (
                      <p className="text-xs text-muted">A manager can attach this to a waiting order.</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
