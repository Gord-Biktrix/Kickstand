/**
 * A repair's sheet (job_sheets): the bike's condition at check-in and a note per line, plus the two changes staff
 * make to the Lightspeed work order's lines during the inspection: take a line off, or change its price.
 *
 * Line ids are the job page's: "i<workorderItemID>" for a part (WorkorderItem), "l<workorderLineID>" for labour
 * (WorkorderLine). Lightspeed's labour line keeps its description in `note`, so line notes live here, not there.
 */
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { events, jobSheets, type JobSheet } from "@/db/schema";
import { isEmptyIntake, type Intake } from "./intake";
import type { LightspeedClient } from "./lightspeed";
import { lightspeedReason } from "./workorder-lines";

export class LineChangeError extends Error {}

export async function loadJobSheet(db: Db, workorderId: string): Promise<JobSheet | null> {
  const [s] = await db.select().from(jobSheets).where(eq(jobSheets.workorderId, workorderId));
  return s ?? null;
}

export async function saveIntake(db: Db, args: { showroomId: string; workorderId: string; intake: Intake | null; actor: string | null; now?: Date }): Promise<void> {
  const intake = isEmptyIntake(args.intake) ? null : args.intake;
  const at = args.now ?? new Date();
  await db
    .insert(jobSheets)
    .values({ workorderId: args.workorderId, showroomId: args.showroomId, intake, intakeBy: args.actor, intakeAt: at })
    .onConflictDoUpdate({ target: jobSheets.workorderId, set: { intake, intakeBy: args.actor, intakeAt: at } });
}

/** Set (or, with empty text, clear) the note on one line. */
export async function saveLineNote(db: Db, args: { showroomId: string; workorderId: string; lineId: string; text: string; actor: string | null; now?: Date }): Promise<void> {
  if (!/^[il]\d+$|^qc$/.test(args.lineId)) throw new LineChangeError("That line couldn't be found.");
  const text = args.text.trim().slice(0, 500);
  const note = { text, by: args.actor, at: (args.now ?? new Date()).toISOString() };
  const next = text ? sql`${jobSheets.lineNotes} || ${JSON.stringify({ [args.lineId]: note })}::jsonb` : sql`${jobSheets.lineNotes} - ${args.lineId}::text`;
  await db
    .insert(jobSheets)
    .values({ workorderId: args.workorderId, showroomId: args.showroomId, lineNotes: text ? { [args.lineId]: note } : {} })
    .onConflictDoUpdate({ target: jobSheets.workorderId, set: { lineNotes: next } });
}

/** "i123" → the WorkorderItem's path pieces; "l456" → the WorkorderLine's. */
function lineRef(lineId: string): { kind: "WorkorderItem" | "WorkorderLine"; id: string } {
  const m = /^([il])(\d+)$/.exec(lineId);
  if (!m) throw new LineChangeError("That line can't be changed here. Change it in Lightspeed.");
  return { kind: m[1] === "i" ? "WorkorderItem" : "WorkorderLine", id: m[2] };
}

/**
 * Lightspeed changes a line under its work order (Workorder/{id}/WorkorderItem/{itemId}); if that path is refused
 * (404/405) the line's own endpoint is tried. Either way a refusal comes back with Lightspeed's reason.
 */
async function changeLine(client: LightspeedClient, workorderId: string, lineId: string, method: "PUT" | "DELETE", body?: Record<string, unknown>): Promise<void> {
  const ref = lineRef(lineId);
  try {
    try {
      await client.request(method, `Workorder/${workorderId}/${ref.kind}/${ref.id}.json`, body);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 404 && status !== 405) throw err;
      await client.request(method, `${ref.kind}/${ref.id}.json`, body);
    }
  } catch (err) {
    throw new LineChangeError(`Lightspeed didn't take the change: ${lightspeedReason(err)}`);
  }
}

export async function removeLine(db: Db, client: LightspeedClient, args: { showroomId: string; workorderId: string; lineId: string; label: string; actor: string }): Promise<void> {
  await changeLine(client, args.workorderId, args.lineId, "DELETE");
  await db.update(jobSheets).set({ lineNotes: sql`${jobSheets.lineNotes} - ${args.lineId}::text` }).where(eq(jobSheets.workorderId, args.workorderId));
  await db.insert(events).values({ showroomId: args.showroomId, type: "workorder_line_removed", actor: args.actor, payload: { workorder_id: args.workorderId, line: args.lineId, label: args.label } });
}

/** The line's price each (before tax). A part's is its unitPrice; labour's is its unitPriceOverride. */
export async function setLinePrice(db: Db, client: LightspeedClient, args: { showroomId: string; workorderId: string; lineId: string; label: string; price: number; was: number | null; actor: string }): Promise<void> {
  if (!Number.isFinite(args.price) || args.price <= 0 || args.price >= 100_000) throw new LineChangeError("Enter a price above $0. To take it off, press Remove.");
  const price = Math.round(args.price * 100) / 100;
  const ref = lineRef(args.lineId);
  await changeLine(client, args.workorderId, args.lineId, "PUT", ref.kind === "WorkorderItem" ? { unitPrice: price } : { unitPriceOverride: price });
  await db.insert(events).values({ showroomId: args.showroomId, type: "workorder_line_price", actor: args.actor, payload: { workorder_id: args.workorderId, line: args.lineId, label: args.label, from: args.was, to: price } });
}
