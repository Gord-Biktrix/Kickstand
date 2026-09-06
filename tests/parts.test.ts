import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { appointments, dayCounters, orders, units } from "@/db/schema";
import { getAvailability } from "@/lib/availability";
import { bookSlot } from "@/lib/booking";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import { patchShowroomSettings, type ShowroomCtx } from "@/lib/showroom";
import { ordersOnOrder, syncSpecialOrders, type SpecialOrderLine, type SpecialOrderSource } from "@/lib/special-orders";
import { localToUtc } from "@/lib/time";
import { collectParts, inviteOrders } from "@/lib/units";
import { resetDb, testDb, TZ } from "./helpers";

const line = (over: Partial<SpecialOrderLine>): SpecialOrderLine => ({
  saleLineID: "80001", customerID: "3136", itemID: "500", categoryPath: "Accessories/Cargo Storage/Baskets",
  createTime: "2026-09-05T22:36:00+00:00", qty: 1,
  bike: { description: "Front Cargo Basket - Large", qty: 1, model: "", size: null, colour: null },
  ...over,
});
class Fake implements SpecialOrderSource {
  constructor(public rows: SpecialOrderLine[]) {}
  async lines() { return this.rows; }
  async customer() { return { name: "Basket Buyer", email: "b@x.ca", phone: "+16045550300" }; }
}

let db: Db;
let showroom: ShowroomCtx;
let notifier: MemoryNotifier;
const NOW = localToUtc("2026-09-05", "16:37", TZ); // Saturday afternoon
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.$client.end(); });
beforeEach(async () => {
  showroom = await resetDb(db);
  showroom = { ...showroom, settings: { ...showroom.settings, lightspeed: { ...showroom.settings.lightspeed, shop_id: 3 } } };
  await patchShowroomSettings(db, showroom.id, { lightspeed: showroom.settings.lightspeed });
  notifier = new MemoryNotifier(); setNotifier(notifier);
});

describe("parts & accessories", () => {
  it("parts lines become parts orders; completing them in Lightspeed fulfils them here", async () => {
    const src = new Fake([line({}), line({ saleLineID: "80002", bike: { description: "Fat Bike Inner Tube 20x4", qty: 2, model: "", size: null, colour: null }, qty: 2 })]);
    const r = await syncSpecialOrders(db, { showroom, actor: "t", source: src, now: NOW });
    expect(r.parts).toEqual({ created: 2, updated: 0, fulfilled: 0 });
    const parts = await ordersOnOrder(db, showroom, "parts");
    expect(parts.map((o) => o.model).sort()).toEqual(["Fat Bike Inner Tube 20x4 ×2", "Front Cargo Basket - Large"]);
    expect(parts.every((o) => o.kind === "parts")).toBe(true);
    expect(await ordersOnOrder(db, showroom, "bike")).toEqual([]);

    // Invite → one message for the customer covering both items; then Lightspeed completes one line.
    notifier.sent = [];
    const inv = await inviteOrders(db, { showroom, orderIds: parts.map((o) => o.id), actor: "t", now: NOW });
    expect(inv.invited).toBe(2);
    expect(notifier.sent.map((m) => m.metric)).toEqual(["Parts: Order Arrived"]);
    expect(notifier.sent[0].properties.item_kind).toBe("parts");
    expect(notifier.sent[0].properties.bike_count).toBe(2);

    src.rows = [line({})]; // 80002 completed in Lightspeed
    const r2 = await syncSpecialOrders(db, { showroom, actor: "t", source: src, now: NOW });
    expect(r2.parts).toMatchObject({ fulfilled: 1 });
    const [gone] = await db.select().from(orders).where(eq(orders.lsSaleLineId, "80002"));
    expect(gone.status).toBe("fulfilled");
    const [u] = await db.select().from(units).where(eq(units.orderId, gone.id));
    expect(u.status).toBe("picked_up");
  });

  it("parts bookings take any future slot without touching bike capacity, and Collected closes them", async () => {
    await syncSpecialOrders(db, { showroom, actor: "t", source: new Fake([line({})]), now: NOW });
    const [order] = await ordersOnOrder(db, showroom, "parts");
    await inviteOrders(db, { showroom, orderIds: [order.id], actor: "t", now: NOW });
    const [unit] = await db.select().from(units).where(eq(units.orderId, order.id));
    // Saturday 16:37 → the 17:xx slot? window ends 17:15, so today has nothing ≥1h ahead; Tuesday 10:00 is fine (bikes would be too soon).
    const days = await getAvailability(db, { showroom, unit, order, now: NOW });
    const tue = days.find((d) => d.date === "2026-09-08")!;
    expect(tue.bookable).toBe(true);
    expect(tue.slots[0].available).toBe(true);
    await bookSlot(db, { showroom, unitId: unit.id, startsAt: localToUtc("2026-09-08", "12:00", TZ), createdBy: "customer", now: NOW });
    expect((await db.select().from(dayCounters).where(eq(dayCounters.onDate, "2026-09-08")))[0]?.bookedCount ?? 0).toBe(0);
    notifier.sent = [];
    const done = await collectParts(db, { showroom, unitId: unit.id, actor: "staff", now: NOW });
    expect(done.status).toBe("picked_up");
    expect((await db.select().from(appointments).where(eq(appointments.unitId, unit.id)))[0].status).toBe("completed");
    expect(notifier.sent.map((m) => m.metric)).toEqual(["Pickup: Completed"]);
  });
});
