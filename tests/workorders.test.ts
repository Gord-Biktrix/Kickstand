import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { units } from "@/db/schema";
import { patchShowroomSettings, type ShowroomCtx } from "@/lib/showroom";
import { deleteView, listViews, listWorkorders, listWorkorderStatuses, saveView, syncWorkorders, unassignedStatuses, type WorkorderRow, type WorkorderSource, type WorkorderStatusRow } from "@/lib/workorders";
import { makeOrder, makeUnit, resetDb, testDb } from "./helpers";

const STATUSES: WorkorderStatusRow[] = [
  { id: 1, name: "Open", systemValue: "open", sortOrder: 1, htmlColor: "#ccc", archived: false },
  { id: 3, name: "Waiting", systemValue: "waiting", sortOrder: 2, htmlColor: null, archived: false },
  { id: 5, name: "Done & Paid", systemValue: "paid", sortOrder: 8, htmlColor: null, archived: false },
  { id: 8, name: "CA# Ready for Pick up", systemValue: null, sortOrder: 9, htmlColor: "#0f0", archived: false },
  { id: 14, name: "Parts arrived - next in the queue", systemValue: null, sortOrder: 12, htmlColor: null, archived: false },
];
const wo = (over: Partial<WorkorderRow>): WorkorderRow => ({
  id: "100", statusId: 1, customerId: "9020", customerName: "Test Test", item: "Juggernaut Ultra Duo 4 · Azure blue", serial: "BX1",
  note: "Tune up", hookIn: "", hookOut: null, employeeId: "27", saleId: null, timeIn: new Date("2026-09-01T17:00:00Z"), etaOut: new Date("2026-09-08T17:00:00Z"), lsUpdatedAt: new Date("2026-09-04T10:00:00Z"), ...over,
});
class Fake implements WorkorderSource {
  constructor(public open: WorkorderRow[]) {}
  async statuses() { return STATUSES; }
  async openWorkorders() { return this.open; }
}

describe("work-order mirror and views", () => {
  let db: Db;
  let showroom: ShowroomCtx;
  beforeAll(async () => { db = await testDb(); });
  afterAll(async () => { await db.$client.end(); });
  beforeEach(async () => {
    showroom = await resetDb(db);
    showroom = { ...showroom, settings: { ...showroom.settings, lightspeed: { ...showroom.settings.lightspeed, shop_id: 3 } } };
    await patchShowroomSettings(db, showroom.id, { lightspeed: showroom.settings.lightspeed });
  });

  it("mirrors open work orders, links Kickstand-created ones to their bike, and drops closed ones", async () => {
    const order = await makeOrder(db, showroom);
    const unit = await makeUnit(db, showroom, order.id);
    await db.update(units).set({ lsWorkorderId: "9106" }).where(eq(units.id, unit.id));
    const src = new Fake([wo({ id: "9106", statusId: 14 }), wo({ id: "200", statusId: 3, customerName: "Sam Repair", item: "" })]);
    const r1 = await syncWorkorders(db, { showroom, actor: "test", source: src });
    expect(r1).toMatchObject({ statuses: 5, open: 2, added: 2, updated: 0, closed: 0 });
    const rows = await listWorkorders(db, showroom);
    expect(rows.map((w) => w.id).sort()).toEqual(["200", "9106"]);
    expect(rows.find((w) => w.id === "9106")?.unitId).toBe(unit.id);
    expect(rows.find((w) => w.id === "200")?.unitId).toBeNull();
    expect((await listWorkorderStatuses(db)).map((s) => s.name)).toContain("CA# Ready for Pick up");

    // 200 got paid (gone from the open list); 9106 changed status.
    src.open = [wo({ id: "9106", statusId: 8, lsUpdatedAt: new Date("2026-09-05T10:00:00Z") })];
    const r2 = await syncWorkorders(db, { showroom, actor: "test", source: src });
    expect(r2).toMatchObject({ open: 1, added: 0, updated: 1, closed: 1 });
    expect((await listWorkorders(db, showroom)).map((w) => `${w.id}:${w.statusId}`)).toEqual(["9106:8"]);
  });

  it("views are named sets of statuses and filter the list", async () => {
    await syncWorkorders(db, { showroom, actor: "test", source: new Fake([wo({ id: "1", statusId: 1 }), wo({ id: "2", statusId: 3 }), wo({ id: "3", statusId: 8 })]) });
    const ready = await saveView(db, { showroom, name: "Ready for pickup", statusIds: [8], actor: "m" });
    const service = await saveView(db, { showroom, name: "Service", statusIds: [1, 3, 3], actor: "m" });
    expect(service.statusIds).toEqual([1, 3]);
    expect((await listWorkorders(db, showroom, ready.statusIds)).map((w) => w.id)).toEqual(["3"]);
    expect((await listWorkorders(db, showroom, service.statusIds)).map((w) => w.id).sort()).toEqual(["1", "2"]);
    const statuses = await listWorkorderStatuses(db);
    expect(unassignedStatuses(statuses, await listViews(db, showroom)).map((s) => s.id)).toEqual([5, 14]);
    await saveView(db, { showroom, id: ready.id, name: "Ready", statusIds: [8, 14], actor: "m" });
    expect((await listViews(db, showroom)).find((v) => v.id === ready.id)?.statusIds).toEqual([8, 14]);
    await deleteView(db, showroom, service.id);
    expect((await listViews(db, showroom)).map((v) => v.name)).toEqual(["Ready"]);
    await expect(saveView(db, { showroom, name: "", statusIds: [1], actor: "m" })).rejects.toThrow(/name/);
    await expect(saveView(db, { showroom, name: "x", statusIds: [], actor: "m" })).rejects.toThrow(/status/);
  });
});
