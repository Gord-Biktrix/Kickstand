import Link from "next/link";
import { db } from "@/db/client";
import { StatusBadge } from "@/components/status-badge";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { searchCustomers } from "@/lib/customers";
import { sp, type SearchParams } from "@/lib/flash";
import { getShowroom } from "@/lib/showroom";
import { formatDateTime } from "@/lib/time";

export const metadata = { title: "Search" };

/** Global search: every order and box, any status, grouped into customers. */
export default async function SearchPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = sp((await searchParams).q) ?? "";
  await requireUser("staff");
  const showroom = await getShowroom(db);
  const tz = showroom.timezone;
  const hits = await searchCustomers(db, showroom, q);

  return (
    <div>
      <PageHeader title="Search" subtitle="Customers by name, phone, email, sale number, box tag or model — including past pickups." />
      <form action="/app/search" role="search" className="mb-6 flex max-w-xl gap-2">
        <input name="q" defaultValue={q} placeholder="Name, phone, email, sale # or box" className="input flex-1" autoFocus />
        <button type="submit" className="btn btn-primary">Search</button>
      </form>

      {!q.trim() ? (
        <Empty>Type a name, phone number, email, sale number or box tag.</Empty>
      ) : hits.length === 0 ? (
        <Empty>No customers match &ldquo;{q}&rdquo;. New pickup? Use <Link className="underline" href="/app/book">Book pickup</Link>.</Empty>
      ) : (
        <ul className="space-y-3">
          {hits.map((h) => (
            <li key={h.key}>
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <Link href={`/app/customers/${encodeURIComponent(h.key)}`} className="text-lg font-semibold hover:text-accent">{h.name}</Link>
                    <p className="text-sm text-muted">{[h.phone, h.email].filter(Boolean).join(" · ") || "no contact details"}{h.lsCustomerId && <> · <Badge>Lightspeed #{h.lsCustomerId}</Badge></>}</p>
                  </div>
                  <Link href={`/app/customers/${encodeURIComponent(h.key)}`} className="btn btn-sm">View customer</Link>
                </div>
                <ul className="mt-3 divide-y divide-border text-sm">
                  {h.orders.map((o) => {
                    const us = h.units.filter((u) => u.orderId === o.id);
                    return (
                      <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span>
                          <Link className="font-medium hover:text-accent" href={`/app/orders/${o.id}`}>{o.model}</Link>
                          {[o.size, o.colour].filter(Boolean).length > 0 && <span className="text-muted"> · {[o.size, o.colour].filter(Boolean).join(" · ")}</span>}
                          <span className="text-muted"> · {o.source} {o.orderRef}</span>
                        </span>
                        <span className="flex flex-wrap items-center gap-2">
                          {us.length === 0 ? <StatusBadge status={o.status} /> : us.map((u) => (
                            <Link key={u.id} href={`/app/units/${u.id}`} className="flex items-center gap-1 hover:text-accent">box {u.boxTag} <StatusBadge status={u.status} /></Link>
                          ))}
                          <span className="text-xs text-muted">updated {formatDateTime(o.updatedAt, tz)}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
