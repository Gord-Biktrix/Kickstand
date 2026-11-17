/**
 * Moving a job on the Workshop board moves its Lightspeed work order: each column writes one status
 * (To do → Open, In progress → In Progress, Waiting on parts → Parts On Order, Ready → Finished, by default).
 * Ready can also tell the customer, through Klaviyo ("Workshop: Ready"), never Ikeono.
 *
 * Bikes for pickup keep their own Build / Ready buttons (units.ts); this is for repairs: work orders written in
 * Lightspeed and the ones Kickstand made for service bookings.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { bookings, bookingTypes, events, lsWorkorders, lsWorkorderStatuses, type Booking, type LsWorkorder } from "@/db/schema";
import { LightspeedClient, lightspeedEnabled } from "./lightspeed";
import { logger } from "./logger";
import { syncColumnMove } from "./job-log";
import { getNotifier, type Profile } from "./notifier";
import type { ShowroomCtx } from "./showroom";
import { workshopColumns, type BoardColumn, type WorkshopColumns } from "./workshop-columns";

export const WORKSHOP_READY_METRIC = "Workshop: Ready";

type StatusLike = { id: number; name: string; systemValue: string | null; archived?: boolean };

const PREFERRED: Record<BoardColumn, (s: StatusLike) => boolean> = {
  todo: (s) => s.systemValue === "open",
  doing: (s) => /^in progress$/i.test(s.name.trim()),
  parts: (s) => /^parts on order$/i.test(s.name.trim()),
  ready: (s) => s.systemValue === "finished",
};

/** The status a column writes: the obvious one by name if it's in that column, else the column's first status. */
export function writeStatusFor(column: BoardColumn, statuses: StatusLike[], columns: WorkshopColumns): StatusLike | null {
  const inColumn = statuses.filter((s) => !s.archived && columns[column].includes(s.id));
  return inColumn.find(PREFERRED[column]) ?? inColumn[0] ?? null;
}

/** Board card ids: "w:<workorderID>" for a Lightspeed work order, "b:<bookingId>" for a service booking. */
export function parseJobId(id: string): { kind: "workorder" | "booking"; id: string } | null {
  const m = /^([wb]):(.+)$/.exec(id);
  if (!m) return null;
  return { kind: m[1] === "w" ? "workorder" : "booking", id: m[2] };
}

export class WorkshopMoveError extends Error {}

export async function resolveJob(db: Db, showroom: ShowroomCtx, jobId: string): Promise<{ workorderId: string; booking: Booking | null; wo: LsWorkorder | null; typeName: string | null }> {
  const ref = parseJobId(jobId);
  if (!ref) throw new WorkshopMoveError("That job couldn't be found.");
  if (ref.kind === "booking") {
    const [row] = await db.select({ booking: bookings, type: bookingTypes }).from(bookings).innerJoin(bookingTypes, eq(bookingTypes.id, bookings.bookingTypeId)).where(eq(bookings.id, ref.id));
    if (!row || row.booking.showroomId !== showroom.id) throw new WorkshopMoveError("That booking isn't in this store.");
    if (!row.booking.lsWorkorderId) throw new WorkshopMoveError("This booking has no Lightspeed work order yet. Open it and press Create it now.");
    const [wo] = await db.select().from(lsWorkorders).where(eq(lsWorkorders.id, row.booking.lsWorkorderId));
    return { workorderId: row.booking.lsWorkorderId, booking: row.booking, wo: wo ?? null, typeName: row.type.name };
  }
  const [wo] = await db.select().from(lsWorkorders).where(eq(lsWorkorders.id, ref.id));
  if (!wo || wo.showroomId !== showroom.id) throw new WorkshopMoveError("That work order isn't open in this store any more. It may have been paid or archived.");
  const [booking] = await db.select().from(bookings).where(eq(bookings.lsWorkorderId, wo.id));
  return { workorderId: wo.id, booking: booking ?? null, wo, typeName: null };
}

/** Move a job to a column: writes the column's status to Lightspeed, then updates Kickstand's copy. */
export async function moveJob(db: Db, args: { showroom: ShowroomCtx; jobId: string; column: BoardColumn; actor: string; client?: LightspeedClient }): Promise<{ status: string; workorderId: string; booking: Booking | null; wo: LsWorkorder | null; typeName: string | null }> {
  const { showroom } = args;
  if (!lightspeedEnabled(showroom)) throw new WorkshopMoveError("Lightspeed isn't switched on for this store, so the board can't move work orders.");
  const job = await resolveJob(db, showroom, args.jobId);
  const statuses = await db.select().from(lsWorkorderStatuses);
  const target = writeStatusFor(args.column, statuses, workshopColumns(showroom.settings, statuses));
  if (!target) throw new WorkshopMoveError("No Lightspeed status is set for that column. Pick one in Settings › Views.");
  const from = job.wo?.statusId ?? null;
  try {
    await (args.client ?? new LightspeedClient(db)).updateWorkorder(job.workorderId, { workorderStatusID: target.id });
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      // Deleted in Lightspeed: drop it from the board now.
      await db.delete(lsWorkorders).where(eq(lsWorkorders.id, job.workorderId));
      throw new WorkshopMoveError(`Work order #${job.workorderId} was deleted in Lightspeed, so it's been taken off the board.`);
    }
    logger.warn({ err: err instanceof Error ? err.message : String(err), workorderId: job.workorderId }, "workshop move not saved in Lightspeed");
    await db.insert(events).values({ showroomId: showroom.id, type: "workorder_move_failed", actor: args.actor, payload: { workorder_id: job.workorderId, to: target.id, column: args.column } });
    throw new WorkshopMoveError("Lightspeed didn't save that move, so the job stays where it was. Try again in a minute.");
  }
  await db.update(lsWorkorders).set({ statusId: target.id, lsUpdatedAt: new Date() }).where(eq(lsWorkorders.id, job.workorderId));
  await db.insert(events).values({ showroomId: showroom.id, type: "workorder_moved", actor: args.actor, payload: { workorder_id: job.workorderId, booking_id: job.booking?.id ?? null, from, to: target.id, column: args.column } });
  // The job tracker follows the board (Start begins the inspection, Waiting on parts pauses, Ready is Pickup).
  try {
    await syncColumnMove(db, { showroomId: showroom.id, workorderId: job.workorderId, column: args.column, actor: /^[0-9a-f-]{36}$/i.test(args.actor) ? args.actor : null });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), workorderId: job.workorderId }, "job tracker not updated after a move");
  }
  return { status: target.name, ...job };
}

/** Day view: give a job to a mechanic (or nobody) by setting the Lightspeed work order's employee. */
export async function assignMechanic(db: Db, args: { showroom: ShowroomCtx; jobId: string; employeeId: string | null; actor: string; client?: LightspeedClient }): Promise<{ workorderId: string }> {
  const { showroom } = args;
  if (!lightspeedEnabled(showroom)) throw new WorkshopMoveError("Lightspeed isn't switched on for this store, so mechanics can't be assigned here.");
  const job = await resolveJob(db, showroom, args.jobId);
  try {
    await (args.client ?? new LightspeedClient(db)).updateWorkorder(job.workorderId, { employeeID: args.employeeId ? Number(args.employeeId) : 0 });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), workorderId: job.workorderId }, "mechanic not saved in Lightspeed");
    throw new WorkshopMoveError("Lightspeed didn't save the mechanic, so the job stays where it was. Try again in a minute.");
  }
  await db.update(lsWorkorders).set({ employeeId: args.employeeId, lsUpdatedAt: new Date() }).where(eq(lsWorkorders.id, job.workorderId));
  await db.insert(events).values({ showroomId: showroom.id, type: "workorder_assigned", actor: args.actor, payload: { workorder_id: job.workorderId, booking_id: job.booking?.id ?? null, employee_id: args.employeeId } });
  return { workorderId: job.workorderId };
}

export type ReadyResult = { status: string; told: "sent" | "failed" | "skipped" | "no_contact" };

/**
 * Ready: move to the Ready column and, if asked, tell the customer through Klaviyo. A service booking has the
 * customer's details; a walk-in's come from their Lightspeed customer record. Shop bikes (no customer) are never told.
 */
export async function markJobReady(db: Db, args: { showroom: ShowroomCtx; jobId: string; notify: boolean; actor: string; client?: LightspeedClient }): Promise<ReadyResult> {
  const { showroom } = args;
  const client = args.client ?? new LightspeedClient(db);
  const moved = await moveJob(db, { ...args, column: "ready", client });
  if (!args.notify) return { status: moved.status, told: "skipped" };

  let profile: Profile | null = null;
  if (moved.booking) {
    profile = { email: moved.booking.customerEmail, phone: moved.booking.customerPhone, name: moved.booking.customerName, smsConsent: moved.booking.smsConsent };
  } else if (moved.wo?.customerId) {
    try {
      const c = await client.getCustomer(moved.wo.customerId);
      if (c) profile = { email: c.email, phone: c.phone, name: c.name, smsConsent: false };
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), workorderId: moved.workorderId }, "ready: customer lookup failed");
    }
  }
  if (!profile || (!profile.email && !profile.phone)) return { status: moved.status, told: "no_contact" };

  const name = profile.name ?? moved.booking?.customerName ?? moved.wo?.customerName ?? "";
  const properties = {
    customer_name: name,
    first_name: name.split(/\s+/)[0] ?? "",
    item: moved.wo?.item || "",
    job: moved.typeName ?? "",
    workorder_id: moved.workorderId,
    showroom: showroom.name,
    showroom_address: showroom.addressLine,
    showroom_phone: showroom.phone ?? "",
  };
  let told: ReadyResult["told"] = "sent";
  try {
    await getNotifier().send(WORKSHOP_READY_METRIC, profile, properties, `${moved.workorderId}:ready:${Date.now()}`);
  } catch (err) {
    told = "failed";
    logger.warn({ err: err instanceof Error ? err.message : String(err), workorderId: moved.workorderId }, "ready message not sent");
  }
  await db.insert(events).values({ showroomId: showroom.id, type: "workorder_ready_told", actor: args.actor, payload: { workorder_id: moved.workorderId, booking_id: moved.booking?.id ?? null, metric: WORKSHOP_READY_METRIC }, klaviyoStatus: told === "sent" ? "sent" : "failed" });
  return { status: moved.status, told };
}
