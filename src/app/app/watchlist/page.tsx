import Link from "next/link";
import { db } from "@/db/client";
import { StatusBadge } from "@/components/status-badge";
import { Badge, Card, Empty, Field, Flash, PageHeader } from "@/components/ui";
import { hasRole, requireUser } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import { sp, type SearchParams } from "@/lib/flash";
import { watchlist, type WatchRow } from "@/lib/queries";
import { formatDateTime, formatLongDate, formatLongDateFromLocal } from "@/lib/time";
import { grantExtensionAction, resendInviteAction, retagUnitAction, waiveStorageAction } from "../actions";
import { currentShowroom } from "@/lib/current-showroom";

export const metadata = { title: "Alerts" };

const RETURN = "/app/watchlist";

type Ctx = { tz: string; manager: boolean; extensionDays: number };

function UnitLine({ r, tz }: { r: WatchRow; tz: string }) {
  return (
    <div className="min-w-0">
      <p className="font-medium">
        <Link href={`/app/units/${r.unit.id}`} className="hover:text-accent">{r.order?.customerName ?? "Unassigned"}</Link>
        <span className="ml-2 text-sm font-normal text-muted">{r.unit.model} · box {r.unit.boxTag}</span>
      </p>
      <p className="text-xs text-muted">
        Invited {r.unit.invitedAt ? formatDateTime(r.unit.invitedAt, tz) : "—"} · day {r.age ?? "—"} · book by {r.unit.bookBy ? formatLongDate(r.unit.bookBy, tz) : "—"} · pick up by {r.unit.pickupBy ? formatLongDate(r.unit.pickupBy, tz) : "—"}
      </p>
      <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
        <StatusBadge status={r.unit.status} />
        {r.callDue && <Badge tone="danger">Call due (day 10+)</Badge>}
        {r.order?.paymentStatus === "deposit" && <Badge tone="warn">balance {formatMoney(r.order.balanceCents)}</Badge>}
        {r.storageDueCents > 0 && <Badge tone="danger">storage {formatMoney(r.storageDueCents)}</Badge>}
        {r.unit.extensionCount > 0 && <Badge tone="neutral">{r.unit.extensionCount} extension{r.unit.extensionCount === 1 ? "" : "s"}</Badge>}
        <Badge tone="neutral">terms v{r.order?.termsVersion ?? 1}</Badge>
      </div>
    </div>
  );
}

function RowActions({ r, ctx, waive }: { r: WatchRow; ctx: Ctx; waive?: boolean }) {
  return (
    <div className="flex flex-wrap items-start gap-2">
      <form action={resendInviteAction.bind(null, r.unit.id, RETURN)}>
        <button type="submit" className="btn btn-sm" disabled={r.unit.status !== "invited"}>Send invite again</button>
      </form>
      {ctx.manager && (
        <details className="relative">
          <summary className="btn btn-sm cursor-pointer list-none">Extend</summary>
          <form action={grantExtensionAction.bind(null, r.unit.id, RETURN)} className="mt-2 w-64 space-y-2 rounded-lg border border-border bg-card p-3 shadow">
            <Field label={`Extend by ${ctx.extensionDays} days — reason`} htmlFor={`ext-${r.unit.id}`}>
              <input id={`ext-${r.unit.id}`} name="reason" required className="input" />
            </Field>
            <button type="submit" className="btn btn-primary btn-sm">Grant extension</button>
          </form>
        </details>
      )}
      {ctx.manager && waive && (
        <details className="relative">
          <summary className="btn btn-sm cursor-pointer list-none">Waive storage</summary>
          <form action={waiveStorageAction.bind(null, r.unit.id, RETURN)} className="mt-2 w-64 space-y-2 rounded-lg border border-border bg-card p-3 shadow">
            <Field label="Amount ($)" htmlFor={`wa-${r.unit.id}`}><input id={`wa-${r.unit.id}`} name="amount" required inputMode="decimal" className="input" defaultValue={(r.storageDueCents / 100).toFixed(2)} /></Field>
            <Field label="Reason" htmlFor={`wr-${r.unit.id}`}><input id={`wr-${r.unit.id}`} name="reason" required className="input" /></Field>
            <button type="submit" className="btn btn-primary btn-sm">Waive</button>
          </form>
        </details>
      )}
    </div>
  );
}

function Section({ title, rows, ctx, waive }: { title: string; rows: WatchRow[]; ctx: Ctx; waive?: boolean }) {
  return (
    <Card title={`${title} (${rows.length})`}>
      {rows.length === 0 ? <Empty>Nothing here.</Empty> : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.unit.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <UnitLine r={r} tz={ctx.tz} />
              <RowActions r={r} ctx={ctx} waive={waive} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default async function WatchlistPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const user = await requireUser("staff");
  const manager = hasRole(user.role, "manager");
  const showroom = await currentShowroom();
  const tz = showroom.timezone;
  const now = new Date();
  const w = await watchlist(db, showroom, now);
  const ctx: Ctx = { tz, manager, extensionDays: showroom.settings.extension_days };

  return (
    <div>
      <PageHeader title="Alerts" subtitle={manager ? "Needs attention · manager view — actions require a reason and are logged." : "Needs attention · read-only — ask a manager for extensions, waivers and re-tags."} />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <div className="space-y-6">
        <Section title="Unbooked 7+ days" rows={w.unbooked7} ctx={ctx} />
        <Section title="Hold ending this week" rows={w.holdEnding} ctx={ctx} />
        <Section title="Overdue — storage running" rows={w.overdue} ctx={ctx} waive />

        <Card title={`Releasable (${w.releasable.length})`}>
          {!showroom.settings.release_rule_enabled ? (
            <Empty>The release rule is off (Program settings). Units past book-by stay with their customer.</Empty>
          ) : w.releasable.length === 0 ? <Empty>No unbooked units past their book-by date.</Empty> : (
            <ul className="divide-y divide-border">
              {w.releasable.map((r) => (
                <li key={r.unit.id} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <UnitLine r={r} tz={tz} />
                    {r.waitlistMatches.length === 0 ? (
                      <p className="text-xs text-muted">No waitlist order matches this model, size and colour.</p>
                    ) : manager ? (
                      <details>
                        <summary className="btn btn-primary btn-sm cursor-pointer list-none">Re-tag to waitlist</summary>
                        <form action={retagUnitAction.bind(null, r.unit.id, RETURN)} className="mt-2 w-80 space-y-2 rounded-lg border border-border bg-card p-3 shadow">
                          <Field label="Waiting order" htmlFor={`to-${r.unit.id}`}>
                            <select id={`to-${r.unit.id}`} name="to_order_id" className="input" required>
                              {r.waitlistMatches.map((o) => (
                                <option key={o.id} value={o.id}>{o.customerName} — {o.orderRef} (ordered {formatLongDateFromLocal(o.orderDate)})</option>
                              ))}
                            </select>
                          </Field>
                          <Field label="Reason" htmlFor={`rr-${r.unit.id}`}><input id={`rr-${r.unit.id}`} name="reason" required className="input" /></Field>
                          <Field label="Next shipment ETA for the original customer (optional)" htmlFor={`eta-${r.unit.id}`}><input id={`eta-${r.unit.id}`} name="next_shipment_eta" className="input" placeholder="late October" /></Field>
                          {(r.order?.termsVersion ?? 1) < 2 && (
                            <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="customer_agreed" required className="mt-1 h-4 w-4" /> Terms v1 order — the customer agreed to the reassignment</label>
                          )}
                          <button type="submit" className="btn btn-primary btn-sm">Re-tag and invite</button>
                        </form>
                      </details>
                    ) : (
                      <p className="text-xs text-muted">{r.waitlistMatches.length} waiting — manager can re-tag.</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={`Unrecorded outcomes (${w.unrecorded.length})`}>
          {w.unrecorded.length === 0 ? <Empty>Every past pickup has an outcome.</Empty> : (
            <ul className="divide-y divide-border">
              {w.unrecorded.map(({ appointment, unit, order }) => (
                <li key={appointment.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-medium"><Link href={`/app/units/${unit.id}?handover=1`} className="hover:text-accent">{order?.customerName}</Link> <span className="text-sm text-muted">{unit.model} · box {unit.boxTag}</span></p>
                    <p className="text-xs text-muted">Slot {formatDateTime(appointment.startsAt, tz)} — mark completed (handover) or no-show.</p>
                  </div>
                  <Link href={`/app/units/${unit.id}?handover=1`} className="btn btn-sm">Record outcome</Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={`Message failures (${w.failures.length})`}>
          {w.failures.length === 0 ? <Empty>No failed sends in the last 14 days.</Empty> : (
            <ul className="divide-y divide-border text-sm">
              {w.failures.map(({ event, unit, order }) => (
                <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <div>
                    <p><span className="font-medium">{String((event.payload as Record<string, unknown>).metric ?? event.type)}</span> · {order?.customerName ?? "—"} {unit && <Link className="text-xs text-muted underline" href={`/app/units/${unit.id}`}>box {unit.boxTag}</Link>}</p>
                    <p className="text-xs text-danger">{String((event.payload as Record<string, unknown>).error ?? "failed")} · {formatDateTime(event.createdAt, tz)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={`Day-closed conflicts (${w.dayConflicts.length})`}>
          {w.dayConflicts.length === 0 ? <Empty>No bookings on closed or over-capacity days.</Empty> : (
            <ul className="divide-y divide-border text-sm">
              {w.dayConflicts.map((c) => (
                <li key={c.date} className="py-2">
                  <p className="font-medium">{formatLongDateFromLocal(c.date)} — {c.capacity === 0 ? "day closed" : `X lowered to ${c.capacity}`}, {c.booked} booked. Contact the customer{c.booked === 1 ? "" : "s"}.</p>
                  <ul className="mt-1 text-xs text-muted">
                    {c.appointments.map((a) => (
                      <li key={a.id}><Link className="underline" href={`/app/units/${a.unitId}`}>{formatDateTime(a.startsAt, tz)}</Link></li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
