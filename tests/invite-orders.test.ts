import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { units } from "@/db/schema";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import type { ShowroomCtx } from "@/lib/showroom";
import { inviteOrders } from "@/lib/units";
import { makeOrder, makeUnit, resetDb, testDb } from "./helpers";

let db: Db;
let showroom: ShowroomCtx;
let notifier: MemoryNotifier;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.$client.end(); });
beforeEach(async () => { showroom = await resetDb(db); notifier = new MemoryNotifier(); setNotifier(notifier); });

describe("inviteOrders (On order → Send invites)", () => {
  it("receives each bike under its sale reference and sends the invite; skips bikes without contact or already invited", async () => {
    const a = await makeOrder(db, showroom, { orderRef: "SO75056" });
    const noContact = await makeOrder(db, showroom, { orderRef: "SO1", customerEmail: null, customerPhone: null, customerName: "No Contact" });
    const already = await makeOrder(db, showroom, { orderRef: "SO2", customerName: "Already In" });
    await makeUnit(db, showroom, already.id, { boxTag: "SO2", status: "invited" });

    const r = await inviteOrders(db, { showroom, orderIds: [a.id, noContact.id, already.id], actor: "s" });
    expect(r.invited).toBe(1);
    expect(r.skipped).toEqual([expect.stringContaining("No Contact"), expect.stringContaining("Already In: already invited")]);
    const [u] = await db.select().from(units).where(eq(units.orderId, a.id));
    expect(u.boxTag).toBe("SO75056");
    expect(u.status).toBe("invited");
    expect(notifier.sent.map((m) => m.metric)).toEqual(["Pickup: Bike Arrived"]);

    // Second run on the same order: nothing new.
    const r2 = await inviteOrders(db, { showroom, orderIds: [a.id], actor: "s" });
    expect(r2.invited).toBe(0);
    expect(notifier.sent).toHaveLength(1);
  });
});
