import Link from "next/link";
import { db } from "@/db/client";
import { StatusBadge } from "@/components/status-badge";
import { Badge, Card, Empty, Flash, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import { sp, type SearchParams } from "@/lib/flash";
import { todayAppointments } from "@/lib/queries";
import { getShowroom } from "@/lib/showroom";
import { addLocalDays, formatLongDateFromLocal, formatTime, toLocalDate } from "@/lib/time";
import { recordNoShowAction } from "./actions";

export const metadata = { title: "Today" };

export default async function TodayPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  await getCurrentUser();
  const showroom = await getShowroom(db);
  const now = new Date();
  const today = toLocalDate(now, showroom.timezone);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp(q.date) ?? "") ? sp(q.date)! : today;
  const rows = await todayAppointments(db, showroom, date, now);
  const denied = sp(q.denied) === "1";

  return (
    <div>
      <PageHeader
        title={date === today ? "Today" : formatLongDateFromLocal(date)}
        subtitle={`${formatLongDateFromLocal(date)} · ${rows.length} pickup${rows.length === 1 ? "" : "s"} · ${showroom.name}`}
        action={
          <div className="flex gap-2 text-sm">
            <Link className="btn btn-sm" href={`/app?date=${addLocalDays(date, -1)}`}>← Prev</Link>
            <Link className="btn btn-sm" href="/app">Today</Link>
            <Link className="btn btn-sm" href={`/app?date=${addLocalDays(date, 1)}`}>Next →</Link>
          </div>
        }
      />
      <Flash ok={sp(q.ok)} error={denied ? "You don't have permission for that page." : sp(q.error)} />
      {rows.length === 0 ? (
        <Empty>No pickups booked for this day.</Empty>
      ) : (
        <div className="space-y-3">
          {rows.map(({ appointment, unit, order, storageDueCents }) => {
            const passed = appointment.startsAt < now;
            return (
              <Card key={appointment.id}>
                <div className="flex flex-wrap items-start gap-4">
                  <div className="w-24 shrink-0">
                    <p className="text-xl font-semibold">{formatTime(appointment.startsAt, showroom.timezone)}</p>
                    <p className="text-xs text-muted">to {formatTime(appointment.endsAt, showroom.timezone)}</p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      <Link href={`/app/units/${unit.id}`} className="hover:text-accent">{order?.customerName ?? "Unassigned"}</Link>
                      <span className="ml-2 text-sm font-normal text-muted">{order?.orderRef}</span>
                    </p>
                    <p className="text-sm">{unit.model} · {[unit.size, unit.colour].filter(Boolean).join(" · ")} · box {unit.boxTag}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <StatusBadge status={unit.status} />
                      {order && (
                        <Badge tone={order.paymentStatus === "deposit" ? "warn" : "ok"}>
                          {order.paymentStatus === "deposit" ? `Balance ${formatMoney(order.balanceCents)}` : "Paid in full"}
                        </Badge>
                      )}
                      {storageDueCents > 0 && <Badge tone="danger">Storage due {formatMoney(storageDueCents)}</Badge>}
                      {unit.earlyBird && <Badge tone="accent">Early bird — apply reward</Badge>}
                      {unit.noShowCount > 0 && <Badge tone="neutral">{unit.noShowCount} prior no-show</Badge>}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col gap-2">
                    <Link href={`/app/units/${unit.id}?handover=1`} className="btn btn-primary btn-sm">Start handover</Link>
                    {passed && (
                      <form action={recordNoShowAction.bind(null, unit.id, `/app?date=${date}`)}>
                        <button type="submit" className="btn btn-sm w-full">No-show</button>
                      </form>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
