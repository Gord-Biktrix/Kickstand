import Link from "next/link";
import { db } from "@/db/client";
import { ContactFlag } from "@/components/contact-flag";
import { Badge, Card, Empty, Field, Flash, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { customerKey } from "@/lib/customers";
import { sp, type SearchParams } from "@/lib/flash";
import { readMessage, type MessageInfo } from "@/lib/invite-status";
import { METRIC } from "@/lib/messages";
import { messageLog } from "@/lib/queries";
import { addLocalDays, formatDateTime, toLocalDate } from "@/lib/time";
import { currentShowroom } from "@/lib/current-showroom";
import { resendInviteAction } from "../../actions";

export const metadata = { title: "Messages" };

/** Sent → delivered / not delivered, or refused by Klaviyo, in words a manager can act on. */
function result(m: MessageInfo): { label: string; tone: "ok" | "neutral" | "danger"; detail?: string } {
  if (m.klaviyoStatus === "failed") return { label: "Failed", tone: "danger", detail: m.error ?? "Klaviyo refused it" };
  const d = m.delivery;
  if (d?.summary === "delivered") return { label: d.sms?.status === "delivered" ? "Delivered (text)" : "Delivered (email)", tone: "ok" };
  if (d?.summary === "undelivered") {
    const why = [d.sms?.status === "failed" && `text: ${d.sms.reason ?? "not delivered"}`, d.email?.status === "bounced" && `email: ${d.email.reason ?? "bounced"}`].filter(Boolean).join(" · ");
    return { label: "Not delivered", tone: "danger", detail: why || "the carrier rejected it" };
  }
  return { label: "Sent", tone: "neutral", detail: d?.final ? "no delivery report from Klaviyo" : "waiting for a delivery report" };
}

export default async function MessagesReportPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  await requireUser("admin");
  const showroom = await currentShowroom();
  const tz = showroom.timezone;
  const today = toLocalDate(new Date(), tz);
  const isDate = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const from = isDate(sp(q.from)) ? sp(q.from)! : addLocalDays(today, -30);
  const to = isDate(sp(q.to)) ? sp(q.to)! : today;
  const show = sp(q.show) === "all" ? "all" : "problems";
  const rows = await messageLog(db, showroom, from, to, show);
  const here = `/app/reports/messages?from=${from}&to=${to}&show=${show}`;

  return (
    <div>
      <PageHeader
        title="Messages"
        subtitle={<><Link href={`/app/reports?from=${from}&to=${to}`} className="underline">Reports</Link> · {showroom.name} · {from} to {to}</>}
        action={
          <form className="flex items-end gap-2">
            <input type="hidden" name="show" value={show} />
            <Field label="From" htmlFor="from"><input id="from" name="from" type="date" defaultValue={from} className="input" /></Field>
            <Field label="To" htmlFor="to"><input id="to" name="to" type="date" defaultValue={to} className="input" /></Field>
            <button type="submit" className="btn">Apply</button>
          </form>
        }
      />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <nav aria-label="Show" className="mb-4 flex gap-1">
        <Link href={`/app/reports/messages?from=${from}&to=${to}&show=problems`} className={`btn btn-sm ${show === "problems" ? "btn-primary" : ""}`}>Didn&apos;t reach the customer</Link>
        <Link href={`/app/reports/messages?from=${from}&to=${to}&show=all`} className={`btn btn-sm ${show === "all" ? "btn-primary" : ""}`}>All messages</Link>
      </nav>
      {rows.length === 0 ? (
        <Empty>{show === "problems" ? "Every message in this range was sent. Delivery reports arrive from Klaviyo within a few hours." : "No messages in this range."}</Empty>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="table">
            <thead><tr><th>When</th><th>Customer</th><th>Bike</th><th>Message</th><th>Result</th><th></th></tr></thead>
            <tbody>
              {rows.map(({ event, unit, order }) => {
                const m = readMessage(event);
                const r = result(m);
                const isInvite = m.metric === METRIC.bikeArrived;
                return (
                  <tr key={event.id}>
                    <td className="whitespace-nowrap text-xs text-muted">{formatDateTime(event.createdAt, tz)}</td>
                    <td>
                      {order ? (
                        <>
                          <Link href={`/app/customers/${encodeURIComponent(customerKey(order))}`} className="hover:text-accent">{order.customerName}</Link><ContactFlag order={order} />
                          <p className="text-xs text-muted">{[order.customerPhone, order.customerEmail].filter(Boolean).join(" · ") || "no contact details"}</p>
                        </>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td>{unit ? <Link href={`/app/units/${unit.id}`} className="hover:text-accent">{unit.model} <span className="text-xs text-muted">box {unit.boxTag}</span></Link> : "—"}</td>
                    <td className="text-sm">{m.metric.replace(/^(Pickup|Parts):\s*/, "")}</td>
                    <td>
                      <Badge tone={r.tone}>{r.label}</Badge>
                      {r.detail && <p className={`mt-0.5 max-w-xs text-xs ${r.tone === "danger" ? "text-danger" : "text-muted"}`}>{r.detail}</p>}
                    </td>
                    <td className="text-right">
                      <div className="flex justify-end gap-1">
                        {r.tone === "danger" && order && <Link href={`/app/orders/${order.id}`} className="btn btn-sm" title="Correct the phone or email on the order">Fix contact</Link>}
                        {r.tone === "danger" && isInvite && unit?.status === "invited" && (
                          <form action={resendInviteAction.bind(null, unit.id, here)}><button type="submit" className="btn btn-sm">Send invite again</button></form>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      <p className="mt-4 text-xs text-muted">
        &ldquo;Sent&rdquo; means Klaviyo accepted the message. Whether the text or email actually arrived comes back from Klaviyo&apos;s delivery reports, checked by the clock for 48 hours after each send.
      </p>
    </div>
  );
}
