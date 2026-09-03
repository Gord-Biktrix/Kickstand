import Link from "next/link";
import type { ReactNode } from "react";
import { db } from "@/db/client";
import { StatusBadge } from "@/components/status-badge";
import { Badge, Card, Empty, Flash, PageHeader } from "@/components/ui";
import { sp, type SearchParams } from "@/lib/flash";
import { buildBoard, type BuildRow } from "@/lib/queries";
import { getShowroom } from "@/lib/showroom";
import { formatDateTime, formatLongDate, formatShortDateFromLocal, toLocalDate } from "@/lib/time";
import { markReadyAction, startBuildAction } from "../actions";

export const metadata = { title: "Build board" };

function Row({ r, tz, today, action }: { r: BuildRow; tz: string; today: string; action?: ReactNode }) {
  const highlight = r.due && r.unit.status === "booked";
  return (
    <li className={`flex flex-wrap items-center justify-between gap-3 py-3 ${highlight ? "-mx-2 rounded-lg bg-warn-soft px-2" : ""}`}>
      <div className="min-w-0">
        <p className="font-medium">
          <Link href={`/app/units/${r.unit.id}`} className="hover:text-accent">{r.unit.model}</Link>
          <span className="ml-2 text-sm font-normal text-muted">{[r.unit.size, r.unit.colour].filter(Boolean).join(" · ")} · box {r.unit.boxTag}</span>
        </p>
        <p className="text-sm text-muted">{r.order?.customerName} · pickup {formatDateTime(r.appointment.startsAt, tz)}</p>
        <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
          <StatusBadge status={r.unit.status} />
          <Badge tone={r.buildBy < today ? "danger" : r.buildBy === today ? "warn" : "neutral"}>
            build by {r.buildAt ? formatDateTime(r.buildAt, tz) : formatShortDateFromLocal(r.buildBy)}{r.buildBy < today ? " — overdue" : r.buildBy === today ? " — today" : ""}
          </Badge>
          {r.unit.earlyBird && <Badge tone="accent">early bird</Badge>}
        </div>
      </div>
      {action}
    </li>
  );
}

export default async function BuildPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const showroom = await getShowroom(db);
  const now = new Date();
  const tz = showroom.timezone;
  const today = toLocalDate(now, tz);
  const { toBuild, built, needsRebooking } = await buildBoard(db, showroom, now);

  return (
    <div>
      <PageHeader title="Build board" subtitle="A bike is built only for a booked pickup. Pull any row forward when you have time." />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title={`To build (${toBuild.length})`}>
          {toBuild.length === 0 ? <Empty>Nothing to build.</Empty> : (
            <ul className="divide-y divide-border">
              {toBuild.map((r) => (
                <Row key={r.appointment.id} r={r} tz={tz} today={today} action={<form action={startBuildAction.bind(null, r.unit.id, "/app/build")}><button type="submit" className="btn btn-primary btn-sm">Build</button></form>} />
              ))}
            </ul>
          )}
        </Card>
        <Card title={`Built, waiting (${built.length})`}>
          {built.length === 0 ? <Empty>No built bikes waiting.</Empty> : (
            <ul className="divide-y divide-border">
              {built.map((r) => (
                <Row key={r.appointment.id} r={r} tz={tz} today={today} action={r.unit.status === "building" ? <form action={markReadyAction.bind(null, r.unit.id, "/app/build")}><button type="submit" className="btn btn-sm">Ready</button></form> : <Badge tone="ok">Ready</Badge>} />
              ))}
            </ul>
          )}
        </Card>
        <Card title={`Built — needs rebooking (${needsRebooking.length})`}>
          {needsRebooking.length === 0 ? <Empty>None.</Empty> : (
            <ul className="divide-y divide-border">
              {needsRebooking.map(({ unit, order }) => (
                <li key={unit.id} className="py-3">
                  <p className="font-medium"><Link href={`/app/units/${unit.id}`} className="hover:text-accent">{unit.model}</Link> <span className="text-sm font-normal text-muted">box {unit.boxTag}</span></p>
                  <p className="text-sm text-muted">{order?.customerName} · {unit.noShowCount} no-show{unit.noShowCount === 1 ? "" : "s"} · hold until {unit.pickupBy ? formatLongDate(unit.pickupBy, tz) : "—"}</p>
                  <div className="mt-1 flex gap-1.5"><StatusBadge status={unit.status} /></div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
