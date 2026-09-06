/**
 * Work-order mirror + custom views. Kickstand keeps a read-only copy of the shop's open Lightspeed work
 * orders (everything not "Done & Paid" and not archived) so staff can see the whole workshop in one place
 * and cut it into views they define themselves: a view is a name and a set of Lightspeed statuses.
 * Nothing here writes to Lightspeed.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { lsWorkorders, lsWorkorderStatuses, units, workorderViews, type LsWorkorder, type LsWorkorderStatus, type WorkorderView } from "@/db/schema";
import { logEvent } from "./events";
import { asList, getConnection, LightspeedClient } from "./lightspeed";
import type { ShowroomCtx } from "./showroom";

export type WorkorderStatusRow = { id: number; name: string; systemValue: string | null; sortOrder: number; htmlColor: string | null; archived: boolean };
export type WorkorderRow = {
  id: string; statusId: number; customerId: string | null; customerName: string; item: string; serial: string | null;
  note: string; hookIn: string | null; hookOut: string | null; employeeId: string | null; saleId: string | null;
  timeIn: Date | null; etaOut: Date | null; lsUpdatedAt: Date | null;
};

export interface WorkorderSource {
  statuses(): Promise<WorkorderStatusRow[]>;
  openWorkorders(shopID: number): Promise<WorkorderRow[]>;
}

const date = (v: unknown): Date | null => {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export class LightspeedWorkorderSource implements WorkorderSource {
  private client: LightspeedClient;
  constructor(dbx: Db) {
    this.client = new LightspeedClient(dbx);
  }
  async statuses(): Promise<WorkorderStatusRow[]> {
    const res = await (this.client as unknown as { request<T>(m: string, p: string): Promise<T> }).request<Record<string, unknown>>("GET", "WorkorderStatus.json");
    return asList<Record<string, unknown>>(res, "WorkorderStatus").map((s) => ({
      id: Number(s.workorderStatusID),
      name: String(s.name ?? ""),
      systemValue: s.systemValue ? String(s.systemValue) : null,
      sortOrder: Number(s.sortOrder ?? 0),
      htmlColor: s.htmlColor ? String(s.htmlColor) : null,
      archived: String(s.archived) === "true",
    }));
  }
  async openWorkorders(shopID: number): Promise<WorkorderRow[]> {
    const paid = (await this.statuses()).filter((s) => s.systemValue === "paid").map((s) => s.id);
    const q = new URLSearchParams({ shopID: String(shopID), archived: "false", limit: "100", load_relations: '["Customer","Serialized"]' });
    if (paid.length === 1) q.set("workorderStatusID", `!=,${paid[0]}`);
    const rows = await this.client.listAllRows(`Workorder.json?${q.toString()}`, "Workorder");
    return rows
      .filter((w) => !paid.includes(Number(w.workorderStatusID)))
      .map((w) => {
        const c = w.Customer as Record<string, unknown> | undefined;
        const ser = w.Serialized as Record<string, unknown> | undefined;
        const name = c ? [c.firstName, c.lastName].filter(Boolean).join(" ").trim() : "";
        const item = ser ? [ser.description, ser.colorName, ser.sizeName].filter((x) => x && String(x).trim()).map(String).join(" · ") : "";
        return {
          id: String(w.workorderID),
          statusId: Number(w.workorderStatusID),
          customerId: w.customerID && String(w.customerID) !== "0" ? String(w.customerID) : null,
          customerName: name || (c?.company ? String(c.company) : ""),
          item,
          serial: ser?.serial ? String(ser.serial) : null,
          note: String(w.note ?? "").trim(),
          hookIn: w.hookIn ? String(w.hookIn) : null,
          hookOut: w.hookOut ? String(w.hookOut) : null,
          employeeId: w.employeeID && String(w.employeeID) !== "0" ? String(w.employeeID) : null,
          saleId: w.saleID && String(w.saleID) !== "0" ? String(w.saleID) : null,
          timeIn: date(w.timeIn),
          etaOut: date(w.etaOut),
          lsUpdatedAt: date(w.timeStamp),
        };
      });
  }
}

export type WorkorderSyncSummary = { statuses: number; open: number; added: number; updated: number; closed: number };

export async function syncWorkorders(dbx: Db, args: { showroom: ShowroomCtx; actor: string; source?: WorkorderSource; now?: Date }): Promise<WorkorderSyncSummary> {
  const { showroom } = args;
  const shopID = showroom.settings.lightspeed.shop_id;
  if (!shopID) throw new Error(`${showroom.name} has no Lightspeed shop id`);
  if (!args.source && !(await getConnection(dbx))) throw new Error("Lightspeed is not connected");
  const source = args.source ?? new LightspeedWorkorderSource(dbx);
  const now = args.now ?? new Date();

  const statuses = await source.statuses();
  for (const st of statuses) {
    await dbx
      .insert(lsWorkorderStatuses)
      .values({ id: st.id, name: st.name, systemValue: st.systemValue, sortOrder: st.sortOrder, htmlColor: st.htmlColor, archived: st.archived, syncedAt: now })
      .onConflictDoUpdate({ target: lsWorkorderStatuses.id, set: { name: st.name, systemValue: st.systemValue, sortOrder: st.sortOrder, htmlColor: st.htmlColor, archived: st.archived, syncedAt: now } });
  }

  const open = await source.openWorkorders(shopID);
  const existing = await dbx.select({ id: lsWorkorders.id, lsUpdatedAt: lsWorkorders.lsUpdatedAt }).from(lsWorkorders).where(eq(lsWorkorders.showroomId, showroom.id));
  const existingById = new Map(existing.map((e) => [e.id, e]));
  // Link the work orders Kickstand created to their bikes.
  const ours = open.length
    ? await dbx.select({ id: units.id, lsWorkorderId: units.lsWorkorderId }).from(units).where(and(eq(units.showroomId, showroom.id), inArray(units.lsWorkorderId, open.map((w) => w.id))))
    : [];
  const unitByWo = new Map(ours.map((u) => [u.lsWorkorderId!, u.id]));

  const summary: WorkorderSyncSummary = { statuses: statuses.length, open: open.length, added: 0, updated: 0, closed: 0 };
  for (const w of open) {
    const row = { ...w, showroomId: showroom.id, unitId: unitByWo.get(w.id) ?? null, syncedAt: now };
    const prev = existingById.get(w.id);
    if (!prev) summary.added++;
    else if ((prev.lsUpdatedAt?.getTime() ?? 0) !== (w.lsUpdatedAt?.getTime() ?? 0)) summary.updated++;
    await dbx.insert(lsWorkorders).values(row).onConflictDoUpdate({ target: lsWorkorders.id, set: row });
  }
  const openIds = open.map((w) => w.id);
  const gone = existing.filter((e) => !openIds.includes(e.id)).map((e) => e.id);
  if (gone.length) {
    await dbx.delete(lsWorkorders).where(and(eq(lsWorkorders.showroomId, showroom.id), inArray(lsWorkorders.id, gone)));
    summary.closed = gone.length;
  }
  await logEvent(dbx, { showroomId: showroom.id, type: "workorders_synced", actor: args.actor, payload: summary });
  return summary;
}

export async function listWorkorderStatuses(dbx: Db): Promise<LsWorkorderStatus[]> {
  return dbx.select().from(lsWorkorderStatuses).where(eq(lsWorkorderStatuses.archived, false)).orderBy(asc(lsWorkorderStatuses.sortOrder), asc(lsWorkorderStatuses.id));
}

export async function listWorkorders(dbx: Db, showroom: ShowroomCtx, statusIds?: number[]): Promise<LsWorkorder[]> {
  const where = statusIds && statusIds.length ? and(eq(lsWorkorders.showroomId, showroom.id), inArray(lsWorkorders.statusId, statusIds)) : eq(lsWorkorders.showroomId, showroom.id);
  return dbx.select().from(lsWorkorders).where(where).orderBy(asc(lsWorkorders.etaOut), asc(lsWorkorders.timeIn));
}

export async function listViews(dbx: Db, showroom: ShowroomCtx): Promise<WorkorderView[]> {
  return dbx.select().from(workorderViews).where(eq(workorderViews.showroomId, showroom.id)).orderBy(asc(workorderViews.sortOrder), asc(workorderViews.createdAt));
}

export async function saveView(dbx: Db, args: { showroom: ShowroomCtx; id?: string; name: string; statusIds: number[]; actor: string }): Promise<WorkorderView> {
  const name = args.name.trim();
  if (!name) throw new Error("Give the view a name.");
  const statusIds = [...new Set(args.statusIds.filter((n) => Number.isInteger(n)))];
  if (statusIds.length === 0) throw new Error("Pick at least one status.");
  if (args.id) {
    const [row] = await dbx.update(workorderViews).set({ name, statusIds }).where(and(eq(workorderViews.id, args.id), eq(workorderViews.showroomId, args.showroom.id))).returning();
    if (!row) throw new Error("View not found");
    return row;
  }
  const count = (await listViews(dbx, args.showroom)).length;
  const [row] = await dbx.insert(workorderViews).values({ showroomId: args.showroom.id, name, statusIds, sortOrder: count, createdBy: args.actor }).returning();
  return row;
}

export async function deleteView(dbx: Db, showroom: ShowroomCtx, id: string): Promise<void> {
  await dbx.delete(workorderViews).where(and(eq(workorderViews.id, id), eq(workorderViews.showroomId, showroom.id)));
}

/** Statuses that are in no view yet — handy when building the first views. */
export function unassignedStatuses(statuses: LsWorkorderStatus[], views: WorkorderView[]): LsWorkorderStatus[] {
  const used = new Set(views.flatMap((v) => v.statusIds));
  return statuses.filter((s) => !used.has(s.id));
}

export function lightspeedWorkorderUrl(id: string): string {
  // Lightspeed's current work-order screen (the "beta_workorder" view); the old view name returns "View not found".
  return `https://us.merchantos.com/?name=workbench.views.beta_workorder&form_name=view&id=${encodeURIComponent(id)}&tab=details`;
}


