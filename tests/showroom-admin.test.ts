import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { capacityRules } from "@/db/schema";
import { listShowrooms, type ShowroomCtx } from "@/lib/showroom";
import { createShowroom, importShowroomsFromLightspeed, setLightspeedLink, shopToStore, slugify } from "@/lib/showroom-admin";
import { resetDb, testDb, withSettings } from "./helpers";

let db: Db;
let vancouver: ShowroomCtx;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.$client.end(); });
beforeEach(async () => { vancouver = await resetDb(db); });

describe("stores", () => {
  it("creates a store with copied hours and an independent Lightspeed link", async () => {
    expect(slugify("Biktrix Saskatoon")).toBe("saskatoon");
    const sk = await createShowroom(db, { slug: "", name: "Biktrix Saskatoon", timezone: "America/Regina", addressLine: "1 Main St", phone: null, copyCapacityFrom: vancouver.slug });
    expect(sk.slug).toBe("saskatoon");
    expect(sk.settings.lightspeed.enabled).toBe(false);
    const vanRules = await db.select().from(capacityRules).where(eq(capacityRules.showroomId, vancouver.id));
    const skRules = await db.select().from(capacityRules).where(eq(capacityRules.showroomId, sk.id));
    expect(skRules.length).toBe(vanRules.length);
    await expect(createShowroom(db, { slug: "saskatoon", name: "Again", timezone: "America/Regina", addressLine: "", phone: null })).rejects.toThrow(/already exists/);
    await expect(createShowroom(db, { slug: "x", name: "Bad tz", timezone: "Mars/Olympus", addressLine: "", phone: null })).rejects.toThrow(/time zone/);
  });

  it("refuses a shop or status another store already uses", async () => {
    await withSettings(db, vancouver, { lightspeed: { ...vancouver.settings.lightspeed, enabled: true, shop_id: 3, statuses: { booked: 29, completed: 5 } } });
    const sk = await createShowroom(db, { slug: "saskatoon", name: "Biktrix Saskatoon", timezone: "America/Regina", addressLine: "", phone: null });
    await expect(setLightspeedLink(db, sk.id, { enabled: true, shop_id: 3, employee_id: null, open_status_id: 1, booked_status_id: 31, completed_status_id: null })).rejects.toThrow(/already linked to Biktrix Vancouver/);
    await expect(setLightspeedLink(db, sk.id, { enabled: true, shop_id: 7, employee_id: null, open_status_id: 1, booked_status_id: 29, completed_status_id: null })).rejects.toThrow(/already used by Biktrix Vancouver/);
    await expect(setLightspeedLink(db, sk.id, { enabled: true, shop_id: null, employee_id: null, open_status_id: 1, booked_status_id: 31, completed_status_id: null })).rejects.toThrow(/Pick the Lightspeed shop/);
    await setLightspeedLink(db, sk.id, { enabled: true, shop_id: 7, employee_id: 12, open_status_id: 1, booked_status_id: 31, completed_status_id: 32 });
    const saved = (await listShowrooms(db)).find((s) => s.id === sk.id)!;
    expect(saved.settings.lightspeed).toMatchObject({ enabled: true, shop_id: 7, employee_id: 12, statuses: { booked: 31, completed: 32 } });
    // Vancouver untouched.
    const van = (await listShowrooms(db)).find((s) => s.id === vancouver.id)!;
    expect(van.settings.lightspeed.statuses).toEqual({ booked: 29, completed: 5 });
  });

  it("imports the unlinked Lightspeed shops as stores with the link pre-filled but off", async () => {
    expect(shopToStore({ shopID: "2", name: "Biktrix Kelowna Showroom", timeZone: "America/Los_Angeles", addressLine: "1963 Harvey Avenue, Kelowna, British Columbia V1Y 6G5", phone: "(236) 970-6101" }))
      .toMatchObject({ slug: "kelowna", name: "Biktrix Kelowna", timezone: "America/Vancouver", shopId: 2 });
    await withSettings(db, vancouver, { lightspeed: { ...vancouver.settings.lightspeed, enabled: true, shop_id: 3 } });
    const shops = [
      { shopID: "3", name: "Biktrix Vancouver Showroom", timeZone: "America/Los_Angeles", addressLine: "", phone: null },
      { shopID: "4", name: "Biktrix Edmonton Showroom", timeZone: "America/Regina", addressLine: "1 Jasper Ave, Edmonton, Alberta", phone: "780-555-0100" },
    ];
    const r = await importShowroomsFromLightspeed(db, shops, vancouver.slug);
    expect(r.created).toEqual(["Biktrix Edmonton"]);
    expect(r.skipped[0]).toMatch(/Vancouver/);
    const edm = (await listShowrooms(db)).find((s) => s.slug === "edmonton")!;
    expect(edm.timezone).toBe("America/Regina");
    expect(edm.settings.lightspeed).toMatchObject({ enabled: false, shop_id: 4 });
    // Running it again creates nothing.
    expect((await importShowroomsFromLightspeed(db, shops, vancouver.slug)).created).toEqual([]);
  });
});
