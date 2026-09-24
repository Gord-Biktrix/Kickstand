import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { ContactFlag } from "@/components/contact-flag";
import { Alert, Badge, Card, Empty, Flash, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { customerKey } from "@/lib/customers";
import { sp, type SearchParams } from "@/lib/flash";
import { getUnitView } from "@/lib/queries";
import { formatDateTime } from "@/lib/time";
import { combineCandidates, visitMates } from "@/lib/units";
import { currentShowroom } from "@/lib/current-showroom";
import { combinePickupsAction } from "../../../actions";

export const metadata = { title: "Combine pickups" };

/**
 * Combine this bike's pickup with another one — the same customer's second bike, or a partner's bike on
 * a different name (README "One visit, several bikes"). Staff choose whose time to keep.
 */
export default async function CombinePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const { id } = await params;
  const q = await searchParams;
  await requireUser("staff");
  const showroom = await currentShowroom();
  const view = await getUnitView(db, id);
  if (!view || view.unit.showroomId !== showroom.id) notFound();
  const { unit, order, appointment } = view;
  const tz = showroom.timezone;
  const now = new Date();
  const text = (sp(q.q) ?? "").trim();
  const [candidates, mates] = await Promise.all([combineCandidates(db, showroom, unit, order, text, now), appointment ? visitMates(db, appointment) : Promise.resolve([])]);
  const mine = appointment && appointment.startsAt > now ? appointment : null;
  const bikeName = [unit.model, unit.colour].filter(Boolean).join(" · ");
  const canCombine = ["invited", "booked", "building", "ready"].includes(unit.status) || unit.status === "received";

  return (
    <div>
      <PageHeader
        title="Combine pickups"
        subtitle={<>{order?.customerName ?? "—"} · {bikeName} · box {unit.boxTag} · {mine ? <>booked {formatDateTime(mine.startsAt, tz)}{mates.length > 0 && <> with {mates.length} other bike{mates.length === 1 ? "" : "s"}</>}</> : "not booked yet"}</>}
        action={<Link href={`/app/units/${unit.id}`} className="btn btn-sm">Back to bike</Link>}
      />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <p className="mb-4 max-w-3xl text-sm text-muted">
        Put this bike in the same pickup as another bike — the customer&apos;s second bike, or a partner&apos;s bike bought under a different name. You choose whose time to keep; every bike in the pickup that moves goes with it, nobody is charged a late change, and each bike still counts against that day&apos;s capacity. Changed your mind later? Open any bike in the pickup and choose <strong>Split off</strong>.
      </p>
      {!canCombine && <Alert tone="warn">This bike is {unit.status} and can&apos;t be combined.</Alert>}

      <form action={`/app/units/${unit.id}/combine`} className="mb-4 flex flex-wrap gap-2">
        <input name="q" defaultValue={text} placeholder="Search any customer: name, phone, email, sale # or box" className="input h-9 w-96 max-w-full" />
        <button type="submit" className="btn">Search</button>
        {text && <Link href={`/app/units/${unit.id}/combine`} className="btn">Clear</Link>}
      </form>

      <Card title={text ? `Bikes matching “${text}”` : "Likely matches — same customer, surname, phone or email"}>
        {candidates.length === 0 ? (
          <div><Empty>{text ? "No bike in the building matches. Only bikes that have been invited or booked can share a pickup." : "No obvious match. Search for the other customer above."}</Empty></div>
        ) : (
          <form action={combinePickupsAction.bind(null, unit.id)} className="-mx-4 -mb-4 overflow-x-auto sm:-mx-5 sm:-mb-5">
            <table className="table">
              <thead><tr><th>Customer</th><th>Bike</th><th>Their pickup</th><th className="text-right">Combine</th></tr></thead>
              <tbody>
                {candidates.map((c) => {
                  const theirs = c.appointment && c.appointment.startsAt > now ? c.appointment : null;
                  const otherPerson = c.order && order && customerKey(c.order) !== customerKey(order);
                  return (
                    <tr key={c.unit.id}>
                      <td>
                        {c.order ? <Link href={`/app/customers/${encodeURIComponent(customerKey(c.order))}`} className="font-medium hover:text-accent">{c.order.customerName}</Link> : "—"}<ContactFlag order={c.order} />
                        {c.why && <span className="ml-2"><Badge tone={c.why === "Same customer" ? "ok" : "accent"}>{c.why}</Badge></span>}
                        <p className="text-xs text-muted">{c.order?.customerPhone ?? c.order?.customerEmail ?? ""}</p>
                      </td>
                      <td>
                        <Link href={`/app/units/${c.unit.id}`} className="hover:text-accent">{c.unit.model}</Link>
                        <p className="text-xs text-muted">{[c.unit.colour, c.unit.size].filter(Boolean).join(" · ")} · box {c.unit.boxTag}{c.visitBikes > 1 && <> · +{c.visitBikes - 1} more in that pickup</>}</p>
                      </td>
                      <td className="text-sm">{theirs ? formatDateTime(theirs.startsAt, tz) : <span className="text-muted">Not booked</span>}</td>
                      <td className="text-right">
                        <div className="flex flex-wrap justify-end gap-1">
                          {mine && theirs && (
                            <>
                              <button type="submit" name="choice" value={`${c.unit.id}:${mine.id}`} className="btn btn-sm" title={`Move ${c.order?.customerName ?? "their"} pickup to this bike's time`}>Keep this bike&apos;s time</button>
                              <button type="submit" name="choice" value={`${unit.id}:${theirs.id}`} className="btn btn-sm" title="Move this bike's pickup to their time">Keep their time</button>
                            </>
                          )}
                          {mine && !theirs && <button type="submit" name="choice" value={`${c.unit.id}:${mine.id}`} className="btn btn-sm">Add to this bike&apos;s pickup</button>}
                          {!mine && theirs && <button type="submit" name="choice" value={`${unit.id}:${theirs.id}`} className="btn btn-sm">Add this bike to theirs</button>}
                          {!mine && !theirs && unit.status !== "received" && <Link href={`/app/book?unit=${unit.id}&with=${c.unit.id}`} className="btn btn-sm">Book together</Link>}
                          {!mine && !theirs && unit.status === "received" && <span className="text-xs text-muted">Book one of them first</span>}
                        </div>
                        {otherPerson && (mine || theirs) && <p className="mt-1 text-xs text-muted">Both customers will get the pickup texts.</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <label className="flex items-start gap-3 border-t border-border p-4 text-sm sm:px-5">
              <input type="checkbox" name="notify" defaultChecked className="mt-1 h-4 w-4" />
              <span>Text customers whose pickup time changes (or who are added). Untick if you&apos;ve already agreed it with them.</span>
            </label>
          </form>
        )}
      </Card>
    </div>
  );
}
