import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { appointments, events, orders, units } from "@/db/schema";
import { isBikeCategory, ordersOnOrder, syncSpecialOrders, type LineState, type SpecialOrderLine, type SpecialOrderSource, type UnfinishedLine } from "@/lib/special-orders";
import { patchShowroomSettings, type ShowroomCtx } from "@/lib/showroom";
import { makeOrder, makeUnit, resetDb, testDb, TZ } from "./helpers";
import { localToUtc } from "@/lib/time";

const line = (over: Partial<SpecialOrderLine>): SpecialOrderLine => ({
  saleLineID: "75843", customerID: "9020", itemID: "2773", categoryPath: "Bikes/Juggernauts/Lite/Plus",
  createTime: "2026-09-04T23:03:04+00:00", qty: 1,
  bike: { description: "86-Juggernaut Lite Plus - Limited Edition Green", qty: 1, model: "Juggernaut Lite Plus - Limited Edition", size: null, colour: "Green" },
  ...over,
});

class FakeSource implements SpecialOrderSource {
  constructor(public rows: SpecialOrderLine[], public customers: Record<string, { name: string; email: string | null; phone: string | null }>) {}
  calls = 0;
  async lines() { this.calls++; return this.rows; }
  async customer(id: string) { return this.customers[id] ?? { name: "", email: null, phone: null }; }
  states: Record<string, LineState> = {};
  asked: string[] = [];
  async lineState(id: string): Promise<LineState> { this.asked.push(id); return this.states[id] ?? "open"; }
  pending: UnfinishedLine[] = [];
  async unfinished() { return this.pending; }
}

describe("special-order sync", () => {
  let db: Db;
  let showroom: ShowroomCtx;
  beforeAll(async () => { db = await testDb(); });
  afterAll(async () => { await db.$client.end(); });
  beforeEach(async () => {
    showroom = await resetDb(db);
    showroom = { ...showroom, settings: { ...showroom.settings, lightspeed: { ...showroom.settings.lightspeed, shop_id: 3 } } };
    await patchShowroomSettings(db, showroom.id, { lightspeed: showroom.settings.lightspeed });
  });

  it("classifies categories", () => {
    expect(isBikeCategory("Bikes")).toBe(true);
    expect(isBikeCategory("Bikes/Stunners")).toBe(true);
    expect(isBikeCategory("Bike Parts/Brakes")).toBe(false);
    expect(isBikeCategory("Accessories")).toBe(false);
  });

  it("creates orders for bike lines only, linked to the Lightspeed customer, and is idempotent", async () => {
    const src = new FakeSource(
      [line({}), line({ saleLineID: "80001", customerID: "5281", itemID: "892", categoryPath: "Bike Parts/Covers", bike: { description: "Battery Cover", qty: 1, model: "Battery Cover", size: null, colour: null } })],
      { "9020": { name: "Test Test", email: "t@x.ca", phone: "+16045550100" } },
    );
    const r1 = await syncSpecialOrders(db, { showroom, actor: "test", source: src });
    expect(r1).toMatchObject({ seen: 2, bikes: 1, created: 1, updated: 0, skippedParts: 1, errors: [] });
    const [o] = await db.select().from(orders).where(eq(orders.lsSaleLineId, "75843"));
    expect(o).toMatchObject({ customerName: "Test Test", lsCustomerId: "9020", model: "Juggernaut Lite Plus - Limited Edition", colour: "Green", source: "lightspeed", orderRef: "SO75843", orderDate: "2026-09-04", paymentStatus: "deposit" });
    expect(await ordersOnOrder(db, showroom)).toHaveLength(1);

    // Re-run: nothing changes.
    const r2 = await syncSpecialOrders(db, { showroom, actor: "test", source: src });
    expect(r2).toMatchObject({ created: 0, updated: 0 });
    // The parts line became a parts order of its own (Parts tab); bikes stay at one.
    const all = await db.select().from(orders).where(eq(orders.showroomId, showroom.id));
    expect(all.filter((o) => o.kind === "bike")).toHaveLength(1);
    expect(all.filter((o) => o.kind === "parts").map((o) => o.model)).toEqual(["Battery Cover"]);

    // Customer fixed their phone in Lightspeed: the order follows.
    src.customers["9020"] = { name: "Test Test", email: "t@x.ca", phone: "+16045550199" };
    const r3 = await syncSpecialOrders(db, { showroom, actor: "test", source: src });
    expect(r3.updated).toBe(1);
    const [o2] = await db.select().from(orders).where(eq(orders.id, o.id));
    expect(o2.customerPhone).toBe("+16045550199");
    const log = await db.select().from(events).where(eq(events.type, "special_orders_synced"));
    expect(log).toHaveLength(3);
  });

  it("adopts an imported or manual order for the same customer and model instead of duplicating it", async () => {
    const imported = await makeOrder(db, showroom, { orderRef: "CSV-1", source: "manual", customerName: "Test Test", customerPhone: "604 555 0100", customerEmail: null, model: "Juggernaut Lite Plus - Limited Edition", lsCustomerId: null });
    const other = await makeOrder(db, showroom, { orderRef: "CSV-2", source: "manual", customerName: "Test Test", customerPhone: "604 555 0100", model: "Stunner Go" });
    const src = new FakeSource([line({})], { "9020": { name: "Test Test", email: "t@x.ca", phone: "+16045550100" } });
    const r = await syncSpecialOrders(db, { showroom, actor: "test", source: src });
    expect(r).toMatchObject({ bikes: 1, created: 0, adopted: 1 });
    const [o] = await db.select().from(orders).where(eq(orders.id, imported.id));
    expect(o.lsSaleLineId).toBe("75843");
    expect(o.lsCustomerId).toBe("9020");
    const [untouched] = await db.select().from(orders).where(eq(orders.id, other.id));
    expect(untouched.lsSaleLineId).toBeNull();
    expect(await db.select().from(orders).where(eq(orders.showroomId, showroom.id))).toHaveLength(2);
  });

  it("lists only orders without a box as on order", async () => {
    const received = await makeOrder(db, showroom, { orderRef: "R-1" });
    await makeUnit(db, showroom, received.id);
    await makeOrder(db, showroom, { orderRef: "W-1" });
    expect((await ordersOnOrder(db, showroom)).map((o) => o.orderRef)).toEqual(["W-1"]);
  });

  describe("lines that leave Lightspeed's open list", () => {
    const cust = { "9020": { name: "Test Test", email: "t@x.ca", phone: "+16045550100" } };
    const bike = line({});
    const part = line({ saleLineID: "80001", itemID: "892", categoryPath: "Bike Parts/Covers", bike: { description: "Battery Cover", qty: 1, model: "Battery Cover", size: null, colour: null } });

    async function synced() {
      const src = new FakeSource([bike, part], cust);
      await syncSpecialOrders(db, { showroom, actor: "test", source: src });
      src.rows = []; // both lines gone from the open list
      return src;
    }
    const byLine = async (id: string) => (await db.select().from(orders).where(eq(orders.lsSaleLineId, id)))[0];

    it("deleted in Lightspeed → cancelled here (bikes and parts), with an event", async () => {
      const src = await synced();
      src.states = { "75843": "deleted", "80001": "deleted" };
      const r = await syncSpecialOrders(db, { showroom, actor: "test", source: src });
      expect(r.reconciled).toMatchObject({ cancelled: 2, fulfilled: 0 });
      expect((await byLine("75843")).status).toBe("cancelled");
      expect((await byLine("80001")).status).toBe("cancelled");
      expect(await ordersOnOrder(db, showroom)).toEqual([]);
      expect(await ordersOnOrder(db, showroom, "parts")).toEqual([]);
      const ev = await db.select().from(events).where(eq(events.type, "cancelled_in_lightspeed"));
      expect(ev.map((e) => e.payload)).toEqual(expect.arrayContaining([expect.objectContaining({ sale_line_id: "75843" })]));
      // Asked once per vanished line, nothing more, and a re-run has nothing left to ask about.
      expect(src.asked.sort()).toEqual(["75843", "80001"]);
      src.asked = [];
      await syncSpecialOrders(db, { showroom, actor: "test", source: src });
      expect(src.asked).toEqual([]);
    });

    it("completed onto a paid sale → fulfilled; a received box is picked up and its booking completed", async () => {
      const src = await synced();
      const o = await byLine("75843");
      const u = await makeUnit(db, showroom, o.id, { status: "booked" });
      await db.insert(appointments).values({ showroomId: showroom.id, unitId: u.id, onDate: "2026-09-10", startsAt: localToUtc("2026-09-10", "10:00", TZ), endsAt: localToUtc("2026-09-10", "10:30", TZ), status: "booked", createdBy: "customer" });
      src.states = { "75843": "sold", "80001": "sold" };
      const r = await syncSpecialOrders(db, { showroom, actor: "test", source: src });
      expect(r.reconciled).toMatchObject({ fulfilled: 2, cancelled: 0 });
      expect(r.parts?.fulfilled).toBe(1);
      expect((await byLine("75843")).status).toBe("fulfilled");
      expect((await db.select().from(units).where(eq(units.id, u.id)))[0].status).toBe("picked_up");
      expect((await db.select().from(appointments).where(eq(appointments.unitId, u.id)))[0].status).toBe("completed");
    });

    it("still open (older than the window) or on an unfinished sale → left alone", async () => {
      const src = await synced();
      src.states = { "75843": "in_sale" }; // 80001 → "open" by default
      const r = await syncSpecialOrders(db, { showroom, actor: "test", source: src });
      expect(r.reconciled).toEqual({ fulfilled: 0, cancelled: 0, inSale: 1, reopened: 0 });
      expect((await byLine("75843")).status).toBe("open");
      expect((await byLine("80001")).status).toBe("open");
    });

    it("deleted in Lightspeed but a box is already here → kept open, flagged once", async () => {
      const src = await synced();
      const o = await byLine("75843");
      await makeUnit(db, showroom, o.id, { boxTag: "SO75843" });
      src.states = { "75843": "deleted" };
      const r1 = await syncSpecialOrders(db, { showroom, actor: "test", source: src });
      expect(r1.reconciled.cancelled).toBe(0);
      expect(r1.attention).toEqual([expect.stringContaining("SO75843 Test Test — special order deleted in Lightspeed but box SO75843 is already here")]);
      expect((await byLine("75843")).status).toBe("open");
      await syncSpecialOrders(db, { showroom, actor: "test", source: src });
      expect(await db.select().from(events).where(eq(events.type, "lightspeed_line_deleted"))).toHaveLength(1);
    });

    it("a line the sync closed comes back → the order reopens; one staff closed stays closed", async () => {
      const src = await synced();
      src.states = { "75843": "sold", "80001": "sold" };
      await syncSpecialOrders(db, { showroom, actor: "test", source: src });
      // Sale voided in Lightspeed: both lines are open special orders again.
      src.rows = [bike, part];
      const r = await syncSpecialOrders(db, { showroom, actor: "test", source: src });
      expect(r.reconciled.reopened).toBe(2);
      expect(r.created).toBe(0);
      expect((await byLine("75843")).status).toBe("open");
      expect((await byLine("80001")).status).toBe("open");
      // Staff cancelled it in Kickstand (no sync event): the sync does not fight them.
      const staffClosed = await makeOrder(db, showroom, { orderRef: "SO70000", source: "lightspeed", lsSaleLineId: "70000", status: "cancelled", model: "Stunner Go" });
      src.rows = [bike, part, line({ saleLineID: "70000", bike: { description: "Stunner Go", qty: 1, model: "Stunner Go", size: null, colour: null } })];
      const r2 = await syncSpecialOrders(db, { showroom, actor: "test", source: src });
      expect(r2).toMatchObject({ created: 0, reconciled: { reopened: 0 } });
      expect((await db.select().from(orders).where(eq(orders.id, staffClosed.id)))[0].status).toBe("cancelled");
    });

    it("the Sync button reports special orders sitting in unfinished sales; the clock does not ask", async () => {
      const src = new FakeSource([], cust);
      src.pending = [{ saleLineID: "76698", customerID: "9020", saleID: "45100", description: "Juggernaut Lite Plus 2.0 Black 26x4", categoryPath: "Bikes/Juggernauts/Lite/Plus" }];
      const quiet = await syncSpecialOrders(db, { showroom, actor: "clock", source: src });
      expect(quiet.unfinished).toBeUndefined();
      const r = await syncSpecialOrders(db, { showroom, actor: "test", source: src, explain: true });
      expect(r.unfinished).toEqual(["Test Test · Juggernaut Lite Plus 2.0 Black 26x4"]);
      expect(r.created).toBe(0);
    });
  });
});
