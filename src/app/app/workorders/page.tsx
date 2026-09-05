import Link from "next/link";
import { db } from "@/db/client";
import { Badge, Card, Empty, Flash, PageHeader } from "@/components/ui";
import { hasRole, requireUser } from "@/lib/auth";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { formatDateTime, formatShortDateFromLocal, toLocalDate } from "@/lib/time";
import { lightspeedWorkorderUrl, listViews, listWorkorders, listWorkorderStatuses } from "@/lib/workorders";
import { syncWorkordersAction } from "../actions";

export const metadata = { title: "Work orders" };

/**
 * The workshop as Lightspeed sees it, read-only, cut into views staff define in Settings › Views
 * (a view = a set of Lightspeed statuses). "All open" is always there.
 */
export default async function WorkordersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const user = await requireUser("staff");
  const showroom = await currentShowroom(user);
  const tz = showroom.timezone;
  const now = new Date();
  const today = toLocalDate(now, tz);
  const [views, statuses] = await Promise.all([listViews(db, showroom), listWorkorderStatuses(db)]);
  const viewId = sp(q.view) ?? "all";
  const view = views.find((v) => v.id === viewId) ?? null;
  const rows = await listWorkorders(db, showroom, view?.statusIds);
  const all = view ? await listWorkorders(db, showroom) : rows;
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  const text = (sp(q.q) ?? "").trim().toLowerCase();
  const shown = rows.filter((w) => !text || [w.customerName, w.item, w.serial, w.note, w.id, statusById.get(w.statusId)?.name].filter(Boolean).join(" ").toLowerCase().includes(text));
  const countFor = (ids: number[]) => all.filter((w) => ids.includes(w.statusId)).length;
  const synced = all.map((w) => w.syncedAt).sort((a, b) => b.getTime() - a.getTime())[0];
  const canSync = !!showroom.settings.lightspeed.shop_id;
  const RETURN = `/app/workorders?view=${viewId}`;

  return (
    <div>
      <PageHeader
        title="Work orders"
        subtitle={`${all.length} open in Lightspeed · ${showroom.name}${synced ? ` · synced ${formatDateTime(synced, tz)}` : ""}`}
        action={
          <div className="flex gap-2">
            {canSync && <form action={syncWorkordersAction.bind(null, RETURN)}><button type="submit" className="btn btn-sm">Sync from Lightspeed</button></form>}
            {hasRole(user.role, "manager") && <Link href="/app/settings/views" className="btn btn-sm">Edit views</Link>}
          </div>
        }
      />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <nav aria-label="Views" className="flex flex-wrap gap-1">
          <Link href="/app/workorders" className={`btn btn-sm ${!view ? "btn-primary" : ""}`}>All open <span className={!view ? "opacity-80" : "text-muted"}>{all.length}</span></Link>
          {views.map((v) => (
            <Link key={v.id} href={`/app/workorders?view=${v.id}`} className={`btn btn-sm ${view?.id === v.id ? "btn-primary" : ""}`}>
              {v.name} <span className={view?.id === v.id ? "opacity-80" : "text-muted"}>{countFor(v.statusIds)}</span>
            </Link>
          ))}
        </nav>
        <form action="/app/workorders" className="ml-auto flex gap-2">
          <input type="hidden" name="view" value={viewId} />
          <input name="q" defaultValue={text} placeholder="Customer, bike, serial, note or #" className="input h-8 w-56 text-sm" />
          <button type="submit" className="btn btn-sm">Filter</button>
        </form>
      </div>

      {views.length === 0 && hasRole(user.role, "manager") && (
        <p className="mb-4 text-sm text-muted">No views yet. <Link className="underline" href="/app/settings/views">Create one</Link> — for example “Service: in progress” or “Ready for pickup” — by ticking the Lightspeed statuses it should show.</p>
      )}

      {all.length === 0 ? (
        <Empty>{canSync ? <>Nothing synced yet. Press <strong>Sync from Lightspeed</strong>, or wait for the hourly sync.</> : "This store has no Lightspeed shop id yet."}</Empty>
      ) : shown.length === 0 ? (
        <Empty>Nothing in this view.</Empty>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="table">
            <thead><tr><th>#</th><th>Customer</th><th>Bike / item</th><th>Status</th><th>In</th><th>Due</th><th>Hook out / note</th><th></th></tr></thead>
            <tbody>
              {shown.map((w) => {
                const st = statusById.get(w.statusId);
                const dueDate = w.etaOut ? toLocalDate(w.etaOut, tz) : null;
                const overdue = !!dueDate && dueDate < today;
                return (
                  <tr key={w.id}>
                    <td className="text-xs text-muted">{w.id}</td>
                    <td>{w.customerName || <span className="text-muted">—</span>}</td>
                    <td>{w.item || <span className="text-muted">—</span>}{w.serial && <p className="text-xs text-muted">SN {w.serial}</p>}</td>
                    <td>
                      <span className="inline-flex items-center gap-1.5 text-sm">
                        <span className="inline-block h-2.5 w-2.5 rounded-full border border-border" style={{ background: st?.htmlColor ?? "transparent" }} aria-hidden />
                        {st?.name ?? `status ${w.statusId}`}
                      </span>
                    </td>
                    <td className="text-xs text-muted">{w.timeIn ? formatShortDateFromLocal(toLocalDate(w.timeIn, tz)) : "—"}</td>
                    <td className={`text-xs ${overdue ? "text-danger" : "text-muted"}`}>{dueDate ? (dueDate === today ? "today" : formatShortDateFromLocal(dueDate)) : "—"}</td>
                    <td className="max-w-xs text-xs text-muted">
                      {w.hookOut && <p className="font-medium text-fg">{w.hookOut}</p>}
                      <p className="truncate" title={w.note}>{w.note.split("\n")[0]}</p>
                    </td>
                    <td className="text-right">
                      <div className="flex justify-end gap-1">
                        {w.unitId ? <Link href={`/app/units/${w.unitId}`} className="btn btn-primary btn-sm">Bike</Link> : <Badge>Service</Badge>}
                        <a href={lightspeedWorkorderUrl(w.id)} target="_blank" rel="noreferrer" className="btn btn-sm">Lightspeed</a>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
