import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { showrooms } from "@/db/schema";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { canEditShowroom, canSwitchShowroom, pickShowroom, readOnlyReason, showroomForLightspeedShop } from "@/lib/showroom-select";
import { listShowrooms, patchShowroomSettings, type ShowroomCtx } from "@/lib/showroom";
import { resetDb, testDb } from "./helpers";

describe("showroom selection", () => {
  let db: Db;
  let van: ShowroomCtx;
  let sask: ShowroomCtx;
  beforeAll(async () => { db = await testDb(); });
  afterAll(async () => { await db.$client.end(); });
  beforeEach(async () => {
    van = await resetDb(db);
    await db.insert(showrooms).values({ slug: "saskatoon", name: "Biktrix Saskatoon", timezone: "America/Regina", addressLine: "x", settings: { ...DEFAULT_SETTINGS } });
    const all = await listShowrooms(db);
    sask = all.find((s) => s.slug === "saskatoon")!;
    van = all.find((s) => s.slug === "vancouver")!;
  });

  it("everyone may view any store; only admins (or the home store) may edit", () => {
    const all = [van, sask];
    const staffSask = { role: "staff" as const, showroomId: sask.id };
    expect(canSwitchShowroom(staffSask)).toBe(true);
    expect(pickShowroom(all, staffSask, "vancouver", "vancouver").slug).toBe("vancouver"); // follows the cookie …
    expect(canEditShowroom(staffSask, van)).toBe(false); // … but read-only there
    expect(canEditShowroom(staffSask, sask)).toBe(true);
    expect(readOnlyReason(staffSask, van, sask)).toMatch(/view only.*Biktrix Saskatoon/);
    expect(readOnlyReason(staffSask, sask, sask)).toBeNull();
    const managerNoHome = { role: "manager" as const, showroomId: null };
    expect(pickShowroom(all, managerNoHome, null, "vancouver").slug).toBe("vancouver");
    expect(canEditShowroom(managerNoHome, sask)).toBe(true); // no home = legacy single-store account
    const admin = { role: "admin" as const, showroomId: null };
    expect(pickShowroom(all, admin, "saskatoon", "vancouver").slug).toBe("saskatoon");
    expect(pickShowroom(all, admin, "nope", "vancouver").slug).toBe("vancouver");
    expect(canEditShowroom(admin, sask)).toBe(true);
    const adminHomeSask = { role: "admin" as const, showroomId: sask.id };
    expect(pickShowroom(all, adminHomeSask, null, "vancouver").slug).toBe("saskatoon"); // home before default
    expect(canEditShowroom(adminHomeSask, van)).toBe(true);
    expect(pickShowroom(all, null, null, "vancouver").slug).toBe("vancouver");
    expect(canEditShowroom(null, van)).toBe(false);
  });

  it("maps the Lightspeed button's shopID to the right showroom", async () => {
    await patchShowroomSettings(db, van.id, { lightspeed: { ...van.settings.lightspeed, shop_id: 3 } });
    await patchShowroomSettings(db, sask.id, { lightspeed: { ...sask.settings.lightspeed, shop_id: 7 } });
    expect((await showroomForLightspeedShop(db, "3"))?.slug).toBe("vancouver");
    expect((await showroomForLightspeedShop(db, 7))?.slug).toBe("saskatoon");
    expect(await showroomForLightspeedShop(db, "9")).toBeNull();
    expect(await showroomForLightspeedShop(db, "abc")).toBeNull();
  });
});
