import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { events, orders } from "@/db/schema";
import { isBikeCategory, ordersOnOrder, syncSpecialOrders, type SpecialOrderLine, type SpecialOrderSource } from "@/lib/special-orders";
import { patchShowroomSettings, type ShowroomCtx } from "@/lib/showroom";
import { makeOrder, makeUnit, resetDb, testDb } from "./helpers";

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
    expect(await db.select().from(orders).where(eq(orders.showroomId, showroom.id))).toHaveLength(1);

    // Customer fixed their phone in Lightspeed: the order follows.
    src.customers["9020"] = { name: "Test Test", email: "t@x.ca", phone: "+16045550199" };
    const r3 = await syncSpecialOrders(db, { showroom, actor: "test", source: src });
    expect(r3.updated).toBe(1);
    const [o2] = await db.select().from(orders).where(eq(orders.id, o.id));
    expect(o2.customerPhone).toBe("+16045550199");
    const log = await db.select().from(events).where(eq(events.type, "special_orders_synced"));
    expect(log).toHaveLength(3);
  });

  it("lists only orders without a box as on order", async () => {
    const received = await makeOrder(db, showroom, { orderRef: "R-1" });
    await makeUnit(db, showroom, received.id);
    await makeOrder(db, showroom, { orderRef: "W-1" });
    expect((await ordersOnOrder(db, showroom)).map((o) => o.orderRef)).toEqual(["W-1"]);
  });
});
