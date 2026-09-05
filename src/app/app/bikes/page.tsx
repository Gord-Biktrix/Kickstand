import Link from "next/link";
import { db } from "@/db/client";
import { BulkSelect } from "@/components/bulk-select";
import { StatusBadge } from "@/components/status-badge";
import { Badge, Card, Empty, Flash, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { customerKey } from "@/lib/customers";
import { formatMoney } from "@/lib/format";
import { sp, type SearchParams } from "@/lib/flash";
import { allBikes, type BikeRow } from "@/lib/queries";
import { getShowroom } from "@/lib/showroom";
import { formatDateTime, formatLongDate, formatLongDateFromLocal, formatShortDateFromLocal, toLocalDate } from "@/lib/time";
import { bulkBikesAction, inviteUnitAction, markReadyAction, startBuildAction } from "../actions";

export const metadata = { title: "Bikes" };

const FILTERS = [
  { key: "all", label: "All" },
  { key: "attention", label: "Needs attention" },
  { key: "not_booked", label: "Not booked" },
  { key: "booked", label: "Booked" },
  { key: "building", label: "Building" },
  { key: "ready", label: "Ready" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

function matches(r: BikeRow, f: FilterKey): boolean {
  switch (f) {
    case "all": return true;
    case "attention": return r.attention;
    case "not_booked": return ["received", "invited"].includes(r.unit.status) || r.needsRebooking;
    case "booked": return r.unit.status === "booked";
    case "building": return r.unit.status === "building";
    case "ready": return r.unit.status === "ready";
  }
}

/** Every bike in the building, one list, filtered by what it needs next. Replaces the Arrivals search, Build board and Watchlist as pages. */
export default async function BikesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  await requireUser("staff");
  const showroom = await getShowroom(db);
  const tz = showroom.timezone;
  const now = new Date();
  const today = toLocalDate(now, tz);
  const filter = (FILTERS.some((f) => f.key === sp(q.filter)) ? sp(q.filter) : "all") as FilterKey;
  const text = (sp(q.q) ?? "").trim().toLowerCase();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp(q.date) ?? "") ? sp(q.date)! : null;
  const all = await allBikes(db, showroom, now);
  const rows = all.filter((r) => matches(r, filter)).filter((r) => !date || r.appointment?.onDate === date).filter((r) => {
    if (!text) return true;
    const hay = [r.unit.model, r.unit.boxTag, r.unit.size, r.unit.colour, r.order?.customerName, r.order?.orderRef, r.order?.customerPhone, r.order?.customerEmail].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(text);
  });
  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, all.filter((r) => matches(r, f.key)).length])) as Record<FilterKey, number>;
  const RETURN = `/app/bikes?filter=${filter}${text ? `&q=${encodeURIComponent(text)}` : ""}${date ? `&date=${date}` : ""}`;

  const next = (r: BikeRow) => {
    const { unit, appointment } = r;
    if (appointment) {
      return (
        <>
          <p className="font-medium">{formatDateTime(appointment.startsAt, tz)}{r.unrecorded && <span className="ml-2 text-warn">slot passed</span>}</p>
          {unit.status === "booked" && r.buildBy && <p className={`text-xs ${r.buildDue ? "text-danger" : "text-muted"}`}>build by {r.buildBy === today ? "today" : formatShortDateFromLocal(r.buildBy)}</p>}
        </>
      );
    }
    if (unit.status === "received") return <p className="text-muted">Send the invite</p>;
    if (unit.status === "unassigned") return <p className="text-muted">Attach to an order</p>;
    if (r.needsRebooking) return <p className="text-warn">Needs a new time</p>;
    return (
      <>
        <p className="text-muted">Waiting on the customer{r.age !== null && <> · day {r.age}</>}</p>
        {unit.pickupBy && <p className={`text-xs ${r.overdue ? "text-danger" : "text-muted"}`}>pick up by {formatLongDate(unit.pickupBy, tz)}</p>}
      </>
    );
  };

  return (
    <div>
      <PageHeader
        title="Bikes"
        subtitle={`${all.length} in the building · ${showroom.name}`}
        action={
          <div className="flex gap-2">
            <Link href="/app/arrivals" className="btn btn-sm">Receive a box</Link>
            <Link href="/app/book" className="btn btn-primary btn-sm">Book pickup</Link>
          </div>
        }
      />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      {date && (
        <p className="mb-3 text-sm">
          Showing bookings for <strong>{formatLongDateFromLocal(date)}</strong>. <Link className="underline" href={`/app/bikes?filter=${filter}`}>Show all days</Link>
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <nav aria-label="Filter" className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <Link key={f.key} href={`/app/bikes?filter=${f.key}${text ? `&q=${encodeURIComponent(text)}` : ""}`} className={`btn btn-sm ${f.key === filter ? "btn-primary" : ""}`}>
              {f.label} <span className={f.key === filter ? "opacity-80" : "text-muted"}>{counts[f.key]}</span>
            </Link>
          ))}
        </nav>
        <form action="/app/bikes" className="ml-auto flex gap-2">
          <input type="hidden" name="filter" value={filter} />
          <input name="q" defaultValue={text} placeholder="Name, box, model or sale #" className="input h-8 w-56 text-sm" />
          <button type="submit" className="btn btn-sm">Filter</button>
        </form>
      </div>

      {rows.length === 0 ? (
        <Empty>{all.length === 0 ? <>No bikes in the building. <Link className="underline" href="/app/arrivals">Receive a box</Link> to start.</> : "Nothing matches this filter."}</Empty>
      ) : (
        <>
        {/* Bulk bar: the row checkboxes below belong to this form via form="bulk", so the per-row buttons keep their own forms. */}
        <form id="bulk" action={bulkBikesAction.bind(null, RETURN)} className="card mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 !py-2">
          <BulkSelect total={rows.length} />
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            <button type="submit" name="op" value="invite" className="btn btn-sm">Send invites</button>
            <button type="submit" name="op" value="build" className="btn btn-sm">Mark building</button>
            <button type="submit" name="op" value="ready" className="btn btn-sm">Mark ready</button>
          </div>
          <div className="flex items-center gap-2">
            <button type="submit" name="op" value="cancel" className="btn btn-danger btn-sm" formNoValidate>Cancel bookings</button>
            <select name="reason" className="input h-8 w-auto max-w-[16rem] py-0 text-sm" defaultValue="shop" aria-label="Cancellation reason">
              <option value="shop">Shop closed — rebook link, no penalty</option>
              <option value="customer">Customer asked — cutoff applies</option>
              <option value="staff">Mistake — silent, no penalty</option>
            </select>
          </div>
        </form>
        <Card className="overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr><th className="w-8"></th><th>Bike</th><th>Customer</th><th>Status</th><th>Next</th><th>Flags</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const { unit, order } = r;
                return (
                  <tr key={unit.id} className={r.attention ? "bg-warn-soft/40" : undefined}>
                    <td><input type="checkbox" name="unit_ids" value={unit.id} form="bulk" className="h-4 w-4" aria-label={`Select ${unit.model} box ${unit.boxTag}`} /></td>
                    <td>
                      <Link href={`/app/units/${unit.id}`} className="font-medium hover:text-accent">{unit.model}</Link>
                      <p className="text-xs text-muted">{[unit.size, unit.colour].filter(Boolean).join(" · ")}{[unit.size, unit.colour].some(Boolean) && " · "}box {unit.boxTag}</p>
                    </td>
                    <td>
                      {order ? (
                        <>
                          <Link href={`/app/customers/${encodeURIComponent(customerKey(order))}`} className="hover:text-accent">{order.customerName}</Link>
                          <p className="text-xs text-muted">{order.customerPhone ?? order.customerEmail ?? order.orderRef}</p>
                        </>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td><StatusBadge status={unit.status} /></td>
                    <td className="text-sm">{next(r)}</td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {r.callDue && <Badge tone="danger">Call due</Badge>}
                        {r.overdue && <Badge tone="danger">Overdue</Badge>}
                        {r.buildDue && <Badge tone="warn">Build today</Badge>}
                        {r.unrecorded && <Badge tone="warn">Record outcome</Badge>}
                        {r.releasable && <Badge tone="warn">Releasable</Badge>}
                        {r.storageDueCents > 0 && <Badge tone="danger">Storage {formatMoney(r.storageDueCents)}</Badge>}
                        {order && order.balanceCents > 0 && <Badge>Balance {formatMoney(order.balanceCents)}</Badge>}
                        {unit.noShowCount > 0 && <Badge>{unit.noShowCount} no-show</Badge>}
                        {unit.earlyBird && <Badge tone="accent">Early bird</Badge>}
                      </div>
                    </td>
                    <td className="text-right">
                      <div className="flex justify-end gap-1">
                        {unit.status === "received" && order && (order.customerEmail || order.customerPhone) && (
                          <form action={inviteUnitAction.bind(null, unit.id, RETURN)}><button type="submit" className="btn btn-sm">Send invite</button></form>
                        )}
                        {unit.status === "booked" && <form action={startBuildAction.bind(null, unit.id, RETURN)}><button type="submit" className="btn btn-sm">Build</button></form>}
                        {unit.status === "building" && <form action={markReadyAction.bind(null, unit.id, RETURN)}><button type="submit" className="btn btn-sm">Ready</button></form>}
                        {["invited", "building", "ready"].includes(unit.status) && !r.appointment && <Link href={`/app/book?unit=${unit.id}`} className="btn btn-sm">Book</Link>}
                        <Link href={`/app/units/${unit.id}`} className="btn btn-primary btn-sm">Open</Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
        </>
      )}
      <p className="mt-4 text-xs text-muted">Message failures and day-capacity conflicts are on <Link className="underline" href="/app/watchlist">Alerts</Link>.</p>
    </div>
  );
}
