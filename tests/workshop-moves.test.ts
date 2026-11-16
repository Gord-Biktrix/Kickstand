import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { events, lsWorkorders, lsWorkorderStatuses } from "@/db/schema";
import { saveConnection, setLightspeedFetch } from "@/lib/lightspeed";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import type { ShowroomCtx } from "@/lib/showroom";
import { defaultWorkshopColumns } from "@/lib/workshop-columns";
import { markJobReady, moveJob, parseJobId, WORKSHOP_READY_METRIC, writeStatusFor } from "@/lib/workshop-moves";
import { resetDb, testDb, withSettings } from "./helpers";

type Call = { method: string; url: string; body: Record<string, unknown> | null };
const STATUSES = [
  { id: 1, name: "Open", systemValue: "open" },
  { id: 27, name: "Appointment", systemValue: null },
  { id: 28, name: "In Progress", systemValue: null },
  { id: 22, name: "Needs Testing", systemValue: null },
  { id: 7, name: "Parts On Order", systemValue: null },
  { id: 4, name: "Finished", systemValue: "finished" },
  { id: 5, name: "Done & Paid", systemValue: "paid" },
];

function fakeLightspeed(opts: { fail?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (opts.fail) return json(500, { message: "down" });
    if (/Workorder\/\d+\.json$/.test(url)) return json(200, { Workorder: {} });
    if (/Customer\/9020\.json/.test(url)) return json(200, { Customer: { customerID: "9020", firstName: "Hana", lastName: "Sato", Contact: { Emails: { ContactEmail: { address: "hana@example.com" } }, Phones: { ContactPhone: { number: "604-555-0101", useType: "Mobile" } } } } });
    return json(404, { message: `unhandled ${method} ${url}` });
  };
  return { calls, fetchImpl };
}

describe("moving jobs on the Workshop board", () => {
  let db: Db;
  let van: ShowroomCtx;
  let notifier: MemoryNotifier;

  beforeAll(async () => {
    db = await testDb();
    process.env.LS_CLIENT_ID ??= "test-client";
    process.env.LS_CLIENT_SECRET ??= "test-secret";
  });
  afterAll(async () => { setLightspeedFetch(null); setNotifier(null); await db.$client.end(); });
  beforeEach(async () => {
    van = await resetDb(db);
    await db.delete(lsWorkorderStatuses);
    await db.insert(lsWorkorderStatuses).values(STATUSES);
    notifier = new MemoryNotifier();
    setNotifier(notifier);
    await saveConnection(db, { accountId: "999", accessToken: "acc", refreshToken: "ref", expiresIn: 3600 });
    van = await withSettings(db, van, { lightspeed: { ...van.settings.lightspeed, enabled: true, shop_id: 3 } });
    await db.insert(lsWorkorders).values([
      { id: "10237", showroomId: van.id, statusId: 1, customerId: "9020", customerName: "Hana Sato", item: "Stunner X", note: "Display replacement" },
      { id: "6714", showroomId: van.id, statusId: 1, customerId: null, customerName: "", item: "Swift CVT 2", note: "Battery cuts out" },
    ]);
  });

  it("each column writes its obvious status", () => {
    const cols = defaultWorkshopColumns(STATUSES);
    expect(writeStatusFor("todo", STATUSES, cols)?.name).toBe("Open");
    expect(writeStatusFor("doing", STATUSES, cols)?.name).toBe("In Progress");
    expect(writeStatusFor("parts", STATUSES, cols)?.name).toBe("Parts On Order");
    expect(writeStatusFor("ready", STATUSES, cols)?.name).toBe("Finished");
    expect(parseJobId("w:10237")).toEqual({ kind: "workorder", id: "10237" });
    expect(parseJobId("u:x")).toBeNull();
  });

  it("Start writes In Progress to Lightspeed and to Kickstand's copy, and logs who did it", async () => {
    const ls = fakeLightspeed();
    setLightspeedFetch(ls.fetchImpl);
    const r = await moveJob(db, { showroom: van, jobId: "w:10237", column: "doing", actor: "staff-1" });
    expect(r.status).toBe("In Progress");
    expect(ls.calls).toEqual([expect.objectContaining({ method: "PUT", body: { workorderStatusID: 28 } })]);
    expect((await db.select().from(lsWorkorders).where(eq(lsWorkorders.id, "10237")))[0].statusId).toBe(28);
    const [ev] = await db.select().from(events).where(eq(events.type, "workorder_moved"));
    expect(ev).toMatchObject({ actor: "staff-1", payload: { workorder_id: "10237", from: 1, to: 28, column: "doing" } });
  });

  it("when Lightspeed refuses, nothing changes in Kickstand and staff are told", async () => {
    setLightspeedFetch(fakeLightspeed({ fail: true }).fetchImpl);
    await expect(moveJob(db, { showroom: van, jobId: "w:10237", column: "parts", actor: "staff-1" })).rejects.toThrow(/didn't save/);
    expect((await db.select().from(lsWorkorders).where(eq(lsWorkorders.id, "10237")))[0].statusId).toBe(1);
  });

  it("won't move work orders for a store with Lightspeed off", async () => {
    const off = await withSettings(db, van, { lightspeed: { ...van.settings.lightspeed, enabled: false } });
    await expect(moveJob(db, { showroom: off, jobId: "w:10237", column: "doing", actor: "staff-1" })).rejects.toThrow(/isn't switched on/);
  });

  it("Ready tells a walk-in through Klaviyo using their Lightspeed contact; unticked tells nobody; shop bikes have nobody to tell", async () => {
    const ls = fakeLightspeed();
    setLightspeedFetch(ls.fetchImpl);
    const r = await markJobReady(db, { showroom: van, jobId: "w:10237", notify: true, actor: "staff-1" });
    expect(r).toEqual({ status: "Finished", told: "sent" });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({ metric: WORKSHOP_READY_METRIC, profile: { email: "hana@example.com", phone: "604-555-0101" }, properties: { first_name: "Hana", item: "Stunner X", workorder_id: "10237" } });

    notifier.sent = [];
    expect((await markJobReady(db, { showroom: van, jobId: "w:10237", notify: false, actor: "staff-1" })).told).toBe("skipped");
    expect((await markJobReady(db, { showroom: van, jobId: "w:6714", notify: true, actor: "staff-1" })).told).toBe("no_contact");
    expect(notifier.sent).toHaveLength(0);
  });
});

describe("work order lines for the POS screen", () => {
  it("reads parts and labour from Lightspeed's work order, with item names and prices", async () => {
    const { parseWorkorderLines, linesSubtotal } = await import("@/lib/workorder-lines");
    const wo = {
      WorkorderItems: { WorkorderItem: [{ workorderItemID: "1", itemID: "55", unitPrice: "0", unitQuantity: "1", note: "" }, { workorderItemID: "2", itemID: "77", unitPrice: "12.50", unitQuantity: "2", note: "rear" }] },
      WorkorderLines: { WorkorderLine: { workorderLineID: "9", note: "Tune-up", hours: "1", minutes: "30", unitPriceOverride: "89", unitQuantity: "1" } },
    };
    const names = new Map([["55", { name: "Crank arm, left 170 mm", price: 34 }], ["77", { name: "Tube 20x4", price: 14 }]]);
    const lines = parseWorkorderLines(wo, names);
    expect(lines.map((l) => [l.kind, l.description, l.qty, l.unitPrice, l.minutes])).toEqual([
      ["part", "Crank arm, left 170 mm", 1, 34, null],
      ["part", "Tube 20x4", 2, 12.5, null],
      ["labour", "Tune-up", 1, 89, 90],
    ]);
    expect(linesSubtotal(lines)).toBe(34 + 25 + 89);
    expect(parseWorkorderLines({}, new Map())).toEqual([]);
  });
});
