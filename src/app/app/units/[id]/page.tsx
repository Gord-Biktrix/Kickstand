import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { ConfirmButton } from "@/components/confirm-button";
import { CopyButton } from "@/components/copy-button";
import { StatusBadge } from "@/components/status-badge";
import { Timeline } from "@/components/timeline";
import { Alert, Badge, Card, Dl, Field, Flash, PageHeader } from "@/components/ui";
import { hasRole, requireUser } from "@/lib/auth";
import { callDue, isReleasable, unitAgeDays } from "@/lib/clock";
import { customerKey } from "@/lib/customers";
import { formatMoney } from "@/lib/format";
import { sp, type SearchParams } from "@/lib/flash";
import { customerUrls } from "@/lib/messages";
import { appointmentHistory, getUnitView, unitTimeline } from "@/lib/queries";
import { getShowroom } from "@/lib/showroom";
import { storageDueCents, storageEnabledFor } from "@/lib/storage";
import { formatDateTime, formatLongDate, formatLongDateFromLocal, formatTime } from "@/lib/time";
import { HANDOVER_CHECKLIST, waitlistFor } from "@/lib/units";
import {
  attachUnitAction,
  completeHandoverAction,
  deferUnitAction,
  grantExtensionAction,
  inviteUnitAction,
  markReadyAction,
  recordNoShowAction,
  resendInviteAction,
  retagUnitAction,
  staffCancelBookingAction,
  startBuildAction,
  waiveStorageAction,
} from "../../actions";

export const metadata = { title: "Bike" };

export default async function UnitPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const { id } = await params;
  const q = await searchParams;
  const user = await requireUser("staff");
  const manager = hasRole(user.role, "manager");
  const showroom = await getShowroom(db);
  const view = await getUnitView(db, id);
  if (!view || view.unit.showroomId !== showroom.id) notFound();
  const { unit, order, appointment } = view;
  const tz = showroom.timezone;
  const s = showroom.settings;
  const now = new Date();
  const [events, history] = await Promise.all([unitTimeline(db, unit.id), appointmentHistory(db, unit.id)]);
  const urls = customerUrls(unit);
  const termsVersion = order?.termsVersion ?? 1;
  const due = storageDueCents(unit, termsVersion, s, now, tz);
  const handover = sp(q.handover) === "1" && ["booked", "building", "ready"].includes(unit.status);
  const RETURN = `/app/units/${unit.id}`;
  const releasable = isReleasable(unit, s, now) && !appointment;
  const matches = unit.status === "unassigned" || releasable ? await waitlistFor(db, showroom.id, unit) : [];
  const age = unitAgeDays(unit, now, tz);

  return (
    <div>
      <PageHeader
        title={<>{unit.model} <span className="text-muted">· box {unit.boxTag}</span></>}
        subtitle={
          order ? (
            <>
              <Link className="font-medium text-fg underline" href={`/app/customers/${encodeURIComponent(customerKey(order))}`}>{order.customerName}</Link>
              {order.customerPhone && <> · {order.customerPhone}</>}
              {" · "}
              <Link className="underline" href={`/app/orders/${order.id}`}>{order.source} {order.orderRef}</Link>
              {[unit.size, unit.colour].filter(Boolean).length > 0 && <> · {[unit.size, unit.colour].filter(Boolean).join(" · ")}</>}
            </>
          ) : (
            <>{[unit.size, unit.colour].filter(Boolean).join(" · ")} · no order attached</>
          )
        }
        action={<StatusBadge status={unit.status} />}
      />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />

      {handover && (
        <Card title="Handover checklist" className="mb-6 border-accent/40">
          <form action={completeHandoverAction.bind(null, unit.id)} className="space-y-4">
            <ul className="grid gap-2 sm:grid-cols-2">
              {HANDOVER_CHECKLIST.map((c) => (
                <li key={c.key}>
                  <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="checklist" value={c.key} className="mt-1 h-4 w-4" required /> {c.label}</label>
                </li>
              ))}
            </ul>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="card">
                <p className="text-xs uppercase tracking-wide text-muted">Balance due (Lightspeed)</p>
                <p className="text-lg font-semibold">{order && order.balanceCents > 0 ? formatMoney(order.balanceCents) : "None"}</p>
              </div>
              <div className="card">
                <p className="text-xs uppercase tracking-wide text-muted">Storage due</p>
                <p className="text-lg font-semibold">{formatMoney(due)}</p>
                {unit.storageFrom && <p className="text-xs text-muted">since {formatLongDate(unit.storageFrom, tz)}</p>}
              </div>
              <div className="card">
                <p className="text-xs uppercase tracking-wide text-muted">Flags</p>
                <div className="mt-1 flex flex-wrap gap-1">{unit.earlyBird && <Badge tone="accent">Early bird — apply {s.early_bird_reward_text}</Badge>}{unit.noShowCount > 0 && <Badge>{unit.noShowCount} no-show</Badge>}</div>
              </div>
            </div>
            {due > 0 && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Storage collected ($)" htmlFor="storage_collected"><input id="storage_collected" name="storage_collected" inputMode="decimal" className="input" defaultValue={(due / 100).toFixed(2)} /></Field>
                <Field label="Storage waived ($)" htmlFor="storage_waived"><input id="storage_waived" name="storage_waived" inputMode="decimal" className="input" defaultValue="0.00" disabled={!manager} /></Field>
                <Field label="Waive reason" htmlFor="waive_reason"><input id="waive_reason" name="waive_reason" className="input" disabled={!manager} /></Field>
              </div>
            )}
            <div className="flex gap-2">
              <button type="submit" className="btn btn-primary">Complete handover</button>
              <Link href={RETURN} className="btn">Cancel</Link>
            </div>
          </form>
        </Card>
      )}

      {/* The booking is what staff come here for: show it first, with the everyday actions beside it. */}
      <Card title="Pickup" className="mb-6">
        {appointment ? (
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-2xl font-semibold">{formatLongDateFromLocal(appointment.onDate)}</p>
              <p className="text-lg">{formatTime(appointment.startsAt, tz)} – {formatTime(appointment.endsAt, tz)}</p>
              <p className="mt-1 text-sm text-muted">
                Booked {formatDateTime(appointment.createdAt, tz)} by {appointment.createdBy === "customer" ? "the customer" : "staff"}
                {unit.pickupBy && <> · pick up by {formatLongDate(unit.pickupBy, tz)}</>}
                {unit.noShowCount > 0 && <> · {unit.noShowCount} no-show</>}
                {appointment.startsAt < now && <> · <span className="text-warn">slot has passed</span></>}
              </p>
            </div>
            <div className="flex flex-wrap items-start gap-2">
              {unit.status === "booked" && <form action={startBuildAction.bind(null, unit.id, RETURN)}><button type="submit" className="btn btn-primary">Build</button></form>}
              {unit.status === "building" && <form action={markReadyAction.bind(null, unit.id, RETURN)}><button type="submit" className="btn btn-primary">Ready</button></form>}
              {["booked", "building", "ready"].includes(unit.status) && !handover && <Link href={`${RETURN}?handover=1`} className={`btn ${unit.status === "ready" ? "btn-primary" : ""}`}>Start handover</Link>}
              <Link href={`/app/book?unit=${unit.id}&reschedule=1`} className="btn">Reschedule</Link>
              <details className="relative">
                <summary className="btn cursor-pointer list-none">Cancel booking</summary>
                <form action={staffCancelBookingAction.bind(null, unit.id, RETURN)} className="card absolute right-0 z-10 mt-2 w-80 space-y-3 shadow-lg">
                  <Field label="Who is cancelling?" htmlFor="cancel_reason">
                    <select id="cancel_reason" name="reason" className="input" defaultValue="customer">
                      <option value="customer">Customer asked — text them a rebook link</option>
                      <option value="shop">We have to cancel — text a rebook link, no penalty</option>
                      <option value="staff">Mistake — no message, no penalty</option>
                    </select>
                  </Field>
                  <p className="text-xs text-muted">Customer cancellations inside {s.reschedule_cutoff_hours} hours count as a missed pickup. The slot is freed either way and the bike goes back to invited.</p>
                  <ConfirmButton className="btn btn-danger w-full" message="Cancel this booking?">Cancel booking</ConfirmButton>
                </form>
              </details>
              {appointment.startsAt < now && (
                <form action={recordNoShowAction.bind(null, unit.id, RETURN)}><ConfirmButton className="btn btn-danger" message="Record a no-show for this appointment? The customer will be sent a rebook link.">Record no-show</ConfirmButton></form>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-2xl font-semibold">
                {unit.status === "received" ? "Not invited yet" : unit.status === "picked_up" ? "Picked up" : unit.status === "unassigned" ? "No customer attached" : "Not booked yet"}
              </p>
              <p className="mt-1 text-sm text-muted">
                {unit.status === "picked_up" && unit.pickedUpAt ? formatDateTime(unit.pickedUpAt, tz) : (
                  <>
                    {unit.invitedAt && <>Invited {formatDateTime(unit.invitedAt, tz)} (day {age})</>}
                    {unit.bookBy && <> · book by {formatLongDate(unit.bookBy, tz)}</>}
                    {unit.pickupBy && <> · pick up by {formatLongDate(unit.pickupBy, tz)}</>}
                    {unit.noShowCount > 0 && <> · {unit.noShowCount} no-show</>}
                    {callDue(unit, now, tz) && <> · <span className="text-danger">call due</span></>}
                  </>
                )}
              </p>
            </div>
            <div className="flex flex-wrap items-start gap-2">
              {unit.status === "received" && (
                <form action={inviteUnitAction.bind(null, unit.id, RETURN)}><button type="submit" className="btn btn-primary" disabled={!order?.customerEmail && !order?.customerPhone}>Send invite</button></form>
              )}
              {["invited", "building", "ready"].includes(unit.status) && <Link href={`/app/book?unit=${unit.id}`} className="btn btn-primary">Book for customer</Link>}
              {unit.status === "invited" && <form action={resendInviteAction.bind(null, unit.id, RETURN)}><button type="submit" className="btn">Send invite again</button></form>}
              {["building", "ready"].includes(unit.status) && !handover && <Link href={`${RETURN}?handover=1`} className="btn">Start handover</Link>}
              {unit.status === "building" && <form action={markReadyAction.bind(null, unit.id, RETURN)}><button type="submit" className="btn">Ready</button></form>}
            </div>
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {order && (
            <Card title="Customer" action={<Link href={`/app/customers/${encodeURIComponent(customerKey(order))}`} className="btn btn-sm">View customer</Link>}>
              <Dl items={[["Name", order.customerName], ["Phone", order.customerPhone ?? "—"], ["Email", order.customerEmail ?? "—"], ["Text reminders", order.smsConsent ? "yes" : "no"], ["Payment", order.paymentStatus === "deposit" ? `deposit · ${formatMoney(order.balanceCents)} due` : "paid"], ["Notes", order.notes ?? "—"]]} />
              <div className="mt-3 flex gap-4 text-sm">
                <Link href={`/app/orders/${order.id}`} className="text-accent underline">Edit order</Link>
                {urls && unit.status !== "unassigned" && <a className="text-accent underline" href={urls.landing_url} target="_blank" rel="noreferrer">Open customer&apos;s page</a>}
              </div>
            </Card>
          )}
          <details className="card">
            <summary className="cursor-pointer text-base font-semibold">Dates and storage</summary>
            <div className="mt-3">
            <Dl
              items={[
                ["Received", formatDateTime(unit.receivedAt, tz)],
                ["Invited", unit.invitedAt ? `${formatDateTime(unit.invitedAt, tz)} (day ${age})` : "—"],
                ["Book by", unit.bookBy ? formatLongDate(unit.bookBy, tz) : "—"],
                ["Pick up by", unit.pickupBy ? formatLongDate(unit.pickupBy, tz) : "—"],
                ["Extensions", `${unit.extensionCount}`],
                ["No-shows", `${unit.noShowCount}`],
                ["Storage", storageEnabledFor(s, termsVersion) ? (unit.storageFrom ? `${formatMoney(due)} due since ${formatLongDate(unit.storageFrom, tz)}${unit.storageWaivedCents ? ` · ${formatMoney(unit.storageWaivedCents)} waived` : ""}` : `not started (${formatMoney(s.storage_rate_cents)}/day after pick-up-by)`) : termsVersion < 2 ? "never charged (terms v1)" : "storage fee disabled"],
                ["Picked up", unit.pickedUpAt ? formatDateTime(unit.pickedUpAt, tz) : "—"],
              ]}
            />
            <div className="mt-3 flex flex-wrap gap-1.5">{callDue(unit, now, tz) && <Badge tone="danger">Call due</Badge>}{unit.earlyBird && <Badge tone="accent">Early bird</Badge>}{releasable && <Badge tone="warn">Releasable</Badge>}</div>
            </div>
          </details>

          <Card title="Booking history">
            {history.length === 0 ? <p className="text-sm text-muted">No bookings yet.</p> : (
              <table className="table">
                <thead><tr><th>Slot</th><th>Status</th><th>By</th><th>Created</th></tr></thead>
                <tbody>
                  {history.map((a) => (
                    <tr key={a.id}>
                      <td>{formatDateTime(a.startsAt, tz)}</td>
                      <td><StatusBadge status={a.status} />{a.cancelledReason && <span className="ml-1 text-xs text-muted">({a.cancelledReason})</span>}</td>
                      <td className="text-xs">{a.createdBy === "customer" ? "customer" : "staff"}</td>
                      <td className="text-xs text-muted">{formatDateTime(a.createdAt, tz)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Timeline"><Timeline events={events} tz={tz} /></Card>
        </div>

        <div className="space-y-6">
          <Card title="More actions">
            <div className="space-y-3">
              {!["picked_up", "unassigned", "received"].includes(unit.status) && (
                manager ? (
                  <details>
                    <summary className="btn w-full cursor-pointer list-none">Extend {s.extension_days} days</summary>
                    <form action={grantExtensionAction.bind(null, unit.id, RETURN)} className="mt-2 space-y-2">
                      <Field label="Reason" htmlFor="ext_reason"><input id="ext_reason" name="reason" required className="input" /></Field>
                      <button type="submit" className="btn btn-primary btn-sm">Grant extension</button>
                    </form>
                  </details>
                ) : <p className="text-xs text-muted">Extensions, waivers and re-tags need a manager.</p>
              )}
              {manager && due > 0 && (
                <details>
                  <summary className="btn w-full cursor-pointer list-none">Waive storage</summary>
                  <form action={waiveStorageAction.bind(null, unit.id, RETURN)} className="mt-2 space-y-2">
                    <Field label="Amount ($)" htmlFor="wv_amount"><input id="wv_amount" name="amount" required inputMode="decimal" className="input" defaultValue={(due / 100).toFixed(2)} /></Field>
                    <Field label="Reason" htmlFor="wv_reason"><input id="wv_reason" name="reason" required className="input" /></Field>
                    <button type="submit" className="btn btn-primary btn-sm">Waive</button>
                  </form>
                </details>
              )}
              {manager && s.defer_enabled && ["invited", "booked"].includes(unit.status) && (
                <details>
                  <summary className="btn w-full cursor-pointer list-none">Defer to next shipment</summary>
                  <form action={deferUnitAction.bind(null, unit.id, RETURN)} className="mt-2 space-y-2">
                    <p className="text-xs text-muted">Customer-requested. Any booking is cancelled without penalty; the unit becomes unassigned.</p>
                    <Field label="Next shipment ETA (optional)" htmlFor="df_eta"><input id="df_eta" name="next_shipment_eta" className="input" placeholder="late October" /></Field>
                    <ConfirmButton className="btn btn-danger btn-sm" message="Defer this order and detach the unit?">Defer</ConfirmButton>
                  </form>
                </details>
              )}
              {manager && releasable && (
                <details>
                  <summary className="btn btn-primary w-full cursor-pointer list-none">Re-tag to waitlist</summary>
                  {matches.length === 0 ? <p className="mt-2 text-xs text-muted">No open order matches this model, size and colour.</p> : (
                    <form action={retagUnitAction.bind(null, unit.id, RETURN)} className="mt-2 space-y-2">
                      <Field label="Waiting order" htmlFor="rt_to"><select id="rt_to" name="to_order_id" className="input" required>{matches.map((o) => <option key={o.id} value={o.id}>{o.customerName} — {o.orderRef} ({o.orderDate})</option>)}</select></Field>
                      <Field label="Reason" htmlFor="rt_reason"><input id="rt_reason" name="reason" required className="input" /></Field>
                      <Field label="Next shipment ETA for the original customer" htmlFor="rt_eta"><input id="rt_eta" name="next_shipment_eta" className="input" /></Field>
                      {termsVersion < 2 && <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="customer_agreed" required className="mt-1 h-4 w-4" /> Terms v1 — customer agreed</label>}
                      <button type="submit" className="btn btn-primary btn-sm">Re-tag and invite</button>
                    </form>
                  )}
                </details>
              )}
              {manager && unit.status === "unassigned" && (
                <div>
                  <p className="mb-2 text-sm font-medium">Attach to a waiting order</p>
                  {matches.length === 0 ? <p className="text-xs text-muted">No open order matches this model, size and colour. Create the order first.</p> : (
                    <form action={attachUnitAction.bind(null, unit.id, RETURN)} className="space-y-2">
                      <select name="order_id" className="input" required>{matches.map((o) => <option key={o.id} value={o.id}>{o.customerName} — {o.orderRef} ({o.orderDate})</option>)}</select>
                      <button type="submit" className="btn btn-primary btn-sm">Attach and invite</button>
                    </form>
                  )}
                </div>
              )}
              {unit.status === "picked_up" && <Alert tone="ok">Picked up {unit.pickedUpAt ? formatDateTime(unit.pickedUpAt, tz) : ""}.</Alert>}
            </div>
          </Card>

          {urls && unit.status !== "unassigned" && (
            <Card title="Customer link">
              <p className="break-all text-xs text-muted">{urls.landing_url}</p>
              <div className="mt-2 flex gap-2"><CopyButton text={urls.landing_url} /><a className="btn btn-sm" href={urls.landing_url} target="_blank" rel="noreferrer">Open</a></div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
