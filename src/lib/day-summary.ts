/**
 * "Done for you today" on the Schedule: what Kickstand sent or did by itself today, so staff see automation
 * working instead of a to-do list. Counts customer messages from the events log (pickups: msg_*, bookings:
 * booking_*), split into invites, reminders, other messages and failures.
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { events } from "@/db/schema";
import type { ShowroomCtx } from "./showroom";
import { startOfLocalDay, type LocalDate } from "./time";

export type DaySummary = { invites: number; reminders: number; otherMessages: number; failed: number };

export function summariseMessageTypes(rows: { type: string; status: string | null; n: number }[]): DaySummary {
  const out: DaySummary = { invites: 0, reminders: 0, otherMessages: 0, failed: 0 };
  for (const r of rows) {
    if (r.status === "failed") { out.failed += r.n; continue; }
    if (r.status !== "sent") continue;
    if (r.type === "msg_bike_arrived") out.invites += r.n;
    else if (r.type.includes("reminder")) out.reminders += r.n;
    else out.otherMessages += r.n;
  }
  return out;
}

export async function automationSummary(dbx: DbOrTx, showroom: ShowroomCtx, date: LocalDate): Promise<DaySummary> {
  const from = startOfLocalDay(date, showroom.timezone);
  const to = new Date(from.getTime() + 24 * 3600_000);
  const rows = await dbx
    .select({ type: events.type, status: events.klaviyoStatus, n: sql<number>`count(*)::int` })
    .from(events)
    .where(and(eq(events.showroomId, showroom.id), gte(events.createdAt, from), lt(events.createdAt, to), sql`(${events.type} like 'msg\\_%' or ${events.type} like 'booking\\_%')`))
    .groupBy(events.type, events.klaviyoStatus);
  return summariseMessageTypes(rows);
}
