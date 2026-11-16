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

describe("new tickets from the POS screen", () => {
  let db: Db;
  let van: ShowroomCtx;
  beforeAll(async () => {
    db = await testDb();
    process.env.LS_CLIENT_ID ??= "test-client";
    process.env.LS_CLIENT_SECRET ??= "test-secret";
  });
  afterAll(async () => { setLightspeedFetch(null); await db.$client.end(); });
  beforeEach(async () => {
    van = await resetDb(db);
    await saveConnection(db, { accountId: "999", accessToken: "acc", refreshToken: "ref", expiresIn: 3600 });
    van = await withSettings(db, van, { lightspeed: { ...van.settings.lightspeed, enabled: true, shop_id: 3, employee_id: 27, open_status_id: 1 } });
  });

  function fakeCreate(opts: { fail?: boolean } = {}) {
    const calls: Call[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
      if (opts.fail) return json(500, {});
      if (method === "POST" && url.endsWith("Customer.json")) return json(200, { Customer: { customerID: "8801" } });
      if (method === "POST" && url.endsWith("Workorder.json")) return json(200, { Workorder: { workorderID: "10300" } });
      return json(404, {});
    };
    return { calls, fetchImpl };
  }
  const base = { bike: "Stunner Lite 3, peach", serial: "BX24-55120", service: "Tune-up", said: "Crank clicks", readyBy: new Date("2026-11-17T01:30:00Z"), employeeId: "31" };

  it("a new customer: creates them, then an Open work order due at ready-by, and puts it in To do at once", async () => {
    const { createTicket } = await import("@/lib/tickets");
    const { workshopJobs } = await import("@/lib/workshop");
    const ls = fakeCreate();
    setLightspeedFetch(ls.fetchImpl);
    const id = await createTicket(db, { showroom: van, ticket: { ...base, customer: { name: "Ahmed Ali", phone: "604 555 0187", email: "" } }, actor: "staff-1", now: new Date("2026-11-16T23:00:00Z") });
    expect(id).toBe("10300");
    expect(ls.calls.find((c) => c.url.endsWith("Customer.json"))!.body).toMatchObject({ firstName: "Ahmed", lastName: "Ali" });
    expect(ls.calls.find((c) => c.url.endsWith("Workorder.json"))!.body).toMatchObject({ shopID: 3, customerID: 8801, employeeID: 31, workorderStatusID: 1, hookIn: "Tune-up", etaOut: "2026-11-17T01:30:00.000Z", timeIn: "2026-11-16T23:00:00.000Z" });
    const jobs = await workshopJobs(db, van, new Date("2026-11-16T23:05:00Z"));
    expect(jobs.find((j) => j.workorderId === "10300")).toMatchObject({ column: "todo", title: "Stunner Lite 3, peach", customer: "Ahmed Ali" });
  });

  it("an existing Lightspeed customer isn't created again; bad input and Lightspeed failures save nothing", async () => {
    const { createTicket } = await import("@/lib/tickets");
    const ls = fakeCreate();
    setLightspeedFetch(ls.fetchImpl);
    await createTicket(db, { showroom: van, ticket: { ...base, customer: { lsCustomerId: "9020", name: "Hana Sato" } }, actor: "staff-1" });
    expect(ls.calls.some((c) => c.url.endsWith("Customer.json"))).toBe(false);
    await expect(createTicket(db, { showroom: van, ticket: { ...base, bike: " ", customer: { lsCustomerId: "9020", name: "Hana" } }, actor: "s" })).rejects.toThrow(/which bike/);
    await expect(createTicket(db, { showroom: van, ticket: { ...base, customer: { name: "No Contact", phone: "", email: "" } }, actor: "s" })).rejects.toThrow(/mobile/);
    setLightspeedFetch(fakeCreate({ fail: true }).fetchImpl);
    await expect(createTicket(db, { showroom: van, ticket: { ...base, customer: { lsCustomerId: "9020", name: "Hana" } }, actor: "s" })).rejects.toThrow(/didn't create/);
    expect((await db.select().from(lsWorkorders)).map((w) => w.id)).toEqual(["10300"]);
  });

  it("lists a customer's bikes from Lightspeed (with serial) and from pickups, and attaches a Lightspeed bike to the ticket", async () => {
    const { customerBikes, createTicket } = await import("@/lib/tickets");
    const { makeOrder, makeUnit } = await import("./helpers");
    const { LightspeedClient } = await import("@/lib/lightspeed");
    const order = await makeOrder(db, van, { customerName: "Ahmed Ali", customerPhone: "+16045550187", lsCustomerId: "9020" });
    await makeUnit(db, van, order.id, { model: "Swift CVT 2", colour: "Green" });
    const calls: Call[] = [];
    setLightspeedFetch(async (input, init) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("Serialized.json") && url.includes("load_relations")) return new Response(JSON.stringify({ message: "Tried to load one or more relations that are not allowed: Item" }), { status: 400 });
      if (url.includes("Serialized.json?customerID=9020")) return json({ Serialized: [{ serializedID: "501", description: "Stunner Lite 3", colorName: "Peach", sizeName: "", serial: "BX24-55120" }, { serializedID: "502", description: "Swift CVT 2", colorName: "Green", serial: "" }, { serializedID: "503", description: "", colorName: "", sizeName: "", serial: "S022YP01561", itemID: "880" }] });
      if (url.includes("Item/880.json?")) return new Response(JSON.stringify({ message: "relations not allowed" }), { status: 400 });
      if (url.endsWith("Item/880.json")) return json({ Item: { description: "86-Kutty X 2 Yellow" } });
      if (url.endsWith("Workorder.json")) return json({ Workorder: { workorderID: "10301" } });
      return new Response("{}", { status: 404 });
    });
    const bikes = await customerBikes(db, { lsCustomerId: "9020", phone: null, email: null }, new LightspeedClient(db));
    expect(bikes.map((b) => [b.label, b.serial, b.serializedId])).toEqual([
      ["Stunner Lite 3 · Peach", "BX24-55120", "501"],
      ["Swift CVT 2 · Green", null, "502"],
      ["Kutty X 2 Yellow", "S022YP01561", "503"],
    ]);
    await createTicket(db, { showroom: van, ticket: { ...base, serializedId: "501", customer: { lsCustomerId: "9020", name: "Ahmed Ali" } }, actor: "s" });
    expect(calls.find((c) => c.url.endsWith("Workorder.json"))!.body).toMatchObject({ serializedID: 501 });
    // Without Lightspeed, the pickup bike still shows.
    expect((await customerBikes(db, { lsCustomerId: null, phone: "604 555 0187", email: null })).map((b) => b.label)).toEqual(["Swift CVT 2 · Green · Regular"]);
  });

  it("finds customers by the last digits of their phone", async () => {
    const { searchCustomers } = await import("@/lib/tickets");
    const { makeOrder } = await import("./helpers");
    await makeOrder(db, van, { customerName: "Ahmed Ali", customerPhone: "+16045550187", lsCustomerId: "9020" });
    const { matches } = await searchCustomers(db, "0187");
    expect(matches.map((m) => [m.name, m.lsCustomerId])).toEqual([["Ahmed Ali", "9020"]]);
  });
});

describe("Lightspeed customer search", () => {
  let db: Db;
  beforeAll(async () => { db = await testDb(); process.env.LS_CLIENT_ID ??= "x"; process.env.LS_CLIENT_SECRET ??= "y"; });
  afterAll(async () => { setLightspeedFetch(null); await db.$client.end(); });

  it("a full name searches first AND last name; one word searches either; Kickstand-only when it has enough", async () => {
    const { searchCustomers } = await import("@/lib/tickets");
    const { LightspeedClient } = await import("@/lib/lightspeed");
    await resetDb(db);
    await saveConnection(db, { accountId: "999", accessToken: "acc", refreshToken: "ref", expiresIn: 3600 });
    const urls: string[] = [];
    setLightspeedFetch(async (input) => {
      urls.push(decodeURIComponent(String(input)));
      return new Response(JSON.stringify({ Customer: { customerID: "77", firstName: "Alan", lastName: "Uyeno", Contact: {} } }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new LightspeedClient(db);
    expect((await searchCustomers(db, "Alan Uyeno", client)).matches.map((m) => m.name)).toEqual(["Alan Uyeno"]);
    expect(urls.at(-1)).toContain("firstName=~,%Alan%&lastName=~,%Uyeno%");
    await searchCustomers(db, "uyeno", client);
    expect(urls.at(-1)).toContain("or=firstName=~,%uyeno%|lastName=~,%uyeno%");
    const before = urls.length;
    await searchCustomers(db, "al", client);
    expect(urls.length).toBe(before); // 2 letters: Kickstand only
  });
});

describe("remembered Lightspeed item names", () => {
  let db: Db;
  beforeAll(async () => { db = await testDb(); process.env.LS_CLIENT_ID ??= "x"; process.env.LS_CLIENT_SECRET ??= "y"; });
  afterAll(async () => { setLightspeedFetch(null); await db.$client.end(); });

  it("asks Lightspeed for an item once, then uses the remembered name", async () => {
    const { itemNames } = await import("@/lib/workorder-lines");
    const { LightspeedClient } = await import("@/lib/lightspeed");
    const { lsItems } = await import("@/db/schema");
    await resetDb(db);
    await db.delete(lsItems);
    await saveConnection(db, { accountId: "999", accessToken: "acc", refreshToken: "ref", expiresIn: 3600 });
    let calls = 0;
    setLightspeedFetch(async () => {
      calls++;
      return new Response(JSON.stringify({ Item: { description: "Crank arm, left", Prices: { ItemPrice: [{ amount: "34", useType: "Default" }] } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new LightspeedClient(db);
    expect((await itemNames(db, ["55"], client)).get("55")).toEqual({ name: "Crank arm, left", price: 34 });
    expect((await itemNames(db, ["55"], client)).get("55")).toEqual({ name: "Crank arm, left", price: 34 });
    expect(calls).toBe(1);
  });
});
