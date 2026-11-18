import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { jobTrackers, lsWorkorders } from "@/db/schema";
import { saveConnection, setLightspeedFetch } from "@/lib/lightspeed";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import type { ShowroomCtx } from "@/lib/showroom";
import { CHECKED_IN_METRIC, ensureTracker, sendTracker, trackerByToken, trackerUrlFor } from "@/lib/tracker";
import { resetDb, testDb, withSettings } from "./helpers";

const STAFF = "11111111-1111-4111-8111-111111111111";

function fakeLightspeed() {
  setLightspeedFetch(async (input) => {
    const url = String(input);
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (/Customer\/9020\.json/.test(url)) return json(200, { Customer: { customerID: "9020", firstName: "Ahmed", lastName: "Ali", Contact: { Phones: { ContactPhone: { number: "604-555-0101", useType: "Mobile" } } } } });
    return json(404, { message: "unhandled" });
  });
}

describe("the customer's repair tracker", () => {
  let db: Db;
  let van: ShowroomCtx;
  let notifier: MemoryNotifier;

  beforeAll(async () => {
    db = await testDb();
    process.env.LS_CLIENT_ID ??= "test-client";
    process.env.LS_CLIENT_SECRET ??= "test-secret";
    process.env.AUTH_SECRET ??= "test-secret-for-tokens";
  });
  afterAll(async () => { setLightspeedFetch(null); setNotifier(null); await db.$client.end(); });
  beforeEach(async () => {
    van = await resetDb(db);
    notifier = new MemoryNotifier();
    setNotifier(notifier);
    fakeLightspeed();
    await saveConnection(db, { accountId: "999", accessToken: "acc", refreshToken: "ref", expiresIn: 3600 });
    van = await withSettings(db, van, { lightspeed: { ...van.settings.lightspeed, enabled: true, shop_id: 3 } });
    await db.delete(lsWorkorders);
    await db.insert(lsWorkorders).values([
      { id: "10237", showroomId: van.id, statusId: 1, customerId: "9020", customerName: "Ahmed Ali", item: "Stunner X" },
      { id: "6714", showroomId: van.id, statusId: 1, customerId: null, customerName: "", item: "Swift CVT 2" },
    ]);
  });

  it("one link per work order: made once, found by its token, the same link every time", async () => {
    const a = await ensureTracker(db, { showroomId: van.id, workorderId: "10237", customerName: "Ahmed Ali" });
    const b = await ensureTracker(db, { showroomId: van.id, workorderId: "10237", customerName: "Ahmed Ali" });
    expect(b.url).toBe(a.url);
    expect(a.url).toMatch(/\/t\/[A-Za-z0-9_-]{40,}$/);
    expect((await trackerByToken(db, a.url.split("/t/")[1]))?.workorderId).toBe("10237");
    expect(await trackerByToken(db, "not-a-real-token-at-all-xx")).toBeNull();
    expect(await trackerUrlFor(db, "10237")).toBe(a.url);
    expect(await trackerUrlFor(db, "6714")).toBeNull();
    expect(await db.select().from(jobTrackers)).toHaveLength(1);
  });

  it("checking in texts the link through Klaviyo; a shop bike with no contact still gets a link to copy", async () => {
    const r = await sendTracker(db, { showroom: van, jobId: "w:10237", actor: STAFF, smsConsent: true });
    expect(r.told).toBe("sent");
    expect(notifier.sent).toEqual([expect.objectContaining({ metric: CHECKED_IN_METRIC, profile: expect.objectContaining({ phone: expect.stringContaining("604"), smsConsent: true }), properties: expect.objectContaining({ first_name: "Ahmed", item: "Stunner X", url: r.url }) })]);
    const again = await sendTracker(db, { showroom: van, jobId: "w:10237", actor: STAFF, smsConsent: true });
    expect(again.url).toBe(r.url);

    const shop = await sendTracker(db, { showroom: van, jobId: "w:6714", actor: STAFF, smsConsent: true });
    expect(shop.told).toBe("no_contact");
    expect(notifier.sent).toHaveLength(2);
  });
});
