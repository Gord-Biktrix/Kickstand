import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { events, lightspeedConnections, orders, units } from "@/db/schema";
import { bookSlot } from "@/lib/booking";
import { saveConnection, setLightspeedFetch, statusNameFor, STATUS_KEYS } from "@/lib/lightspeed";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import type { ShowroomCtx } from "@/lib/showroom";
import { localToUtc } from "@/lib/time";
import { decryptToken } from "@/lib/tokens";
import { inviteUnit } from "@/lib/units";
import { makeOrder, makeUnit, resetDb, testDb, TZ, withSettings } from "./helpers";

let db: Db;
let showroom: ShowroomCtx;
let notifier: MemoryNotifier;
const NOW = localToUtc("2026-09-01", "10:00", TZ);

type Call = { method: string; url: string; body: Record<string, unknown> | null };

/** Minimal fake of the R-Series API: records calls, hands out ids, can force 401/500. */
function fakeLightspeed(opts: { failWorkorder?: boolean; expireFirst?: boolean } = {}) {
  const calls: Call[] = [];
  let ids = 100;
  let unauthorisedOnce = opts.expireFirst ?? false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (url.includes("/auth/oauth/token")) {
      return json(200, { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, scope: "employee:all" });
    }
    if (unauthorisedOnce) {
      unauthorisedOnce = false;
      return json(401, { httpCode: "401", message: "Invalid access token" });
    }
    if (url.endsWith("Customer.json")) return json(200, { Customer: { customerID: String(++ids) } });
    if (url.endsWith("Serialized.json")) return json(200, { Serialized: { serializedID: String(++ids) } });
    if (url.endsWith("Workorder.json")) {
      if (opts.failWorkorder) return json(500, { message: "boom" });
      return json(200, { Workorder: { workorderID: String(++ids), ...body } });
    }
    if (/Workorder\/\d+\.json$/.test(url)) return json(200, { Workorder: { workorderID: url.match(/(\d+)\.json$/)![1], ...body } });
    return json(404, { message: `unhandled ${method} ${url}` });
  };
  return { calls, fetchImpl };
}

const STATUSES = Object.fromEntries(STATUS_KEYS.map((k, i) => [k, 500 + i]));

beforeAll(async () => {
  db = await testDb();
  process.env.LS_CLIENT_ID ??= "test-client";
  process.env.LS_CLIENT_SECRET ??= "test-secret";
});
afterAll(async () => {
  setLightspeedFetch(null);
  await db.$client.end();
});
beforeEach(async () => {
  showroom = await resetDb(db);
  notifier = new MemoryNotifier();
  setNotifier(notifier);
  await saveConnection(db, { accountId: "999", accessToken: "acc", refreshToken: "ref", expiresIn: 3600 });
  showroom = await withSettings(db, showroom, {
    lightspeed: { enabled: true, shop_id: 3, employee_id: 27, open_status_id: 1, due_mode: "pickup", assembly_due_time_local: "10:00", statuses: STATUSES },
  });
});

async function lastMessageEvent(unitId: string) {
  const [e] = await db.select().from(events).where(eq(events.unitId, unitId)).orderBy(desc(events.createdAt)).limit(1);
  return e;
}

describe("Lightspeed bridge", () => {
  it("status names are derived from message keys", () => {
    expect(statusNameFor("bike_arrived")).toBe("Pickup: Bike arrived");
    expect(statusNameFor("reminder_day_before")).toBe("Pickup: Reminder day before");
  });

  it("invite creates customer, customer item and work order with the Bike arrived status", async () => {
    const ls = fakeLightspeed();
    setLightspeedFetch(ls.fetchImpl);
    const order = await makeOrder(db, showroom);
    const unit = await makeUnit(db, showroom, order.id, { boxTag: "JUB2-0001" });
    await inviteUnit(db, { showroom, unitId: unit.id, actor: "staff-1", now: NOW });

    const posts = ls.calls.filter((c) => c.method === "POST").map((c) => c.url.split("/").pop());
    expect(posts).toEqual(["Customer.json", "Serialized.json", "Workorder.json"]);
    const wo = ls.calls.find((c) => c.url.endsWith("Workorder.json"))!.body!;
    expect(wo).toMatchObject({
      shopID: 3,
      employeeID: 27,
      customerID: 101,
      serializedID: 102,
      workorderStatusID: 1, // created Open …
      hookIn: "JUB2-0001",
    });
    // … then moved to the mapped status as a separate change, so Ikeono sees a transition.
    const statusPut = ls.calls.find((c) => c.method === "PUT")!;
    expect(statusPut.url).toMatch(/Workorder\/103\.json$/);
    expect(statusPut.body).toEqual({ workorderStatusID: STATUSES.bike_arrived });
    expect(String(wo.note)).toContain("Juggernaut Ultra Beast 2 · Matte Black · Regular");
    expect(String(wo.note)).toMatch(/Manage: http.*\/manage/);
    // No slot yet → ETA Out is the end of the free hold, so the calendar card sits on the hold date.
    const [invited] = await db.select().from(units).where(eq(units.id, unit.id));
    expect(wo.etaOut).toBe(invited.pickupBy!.toISOString());
    expect(String(wo.hookOut)).toMatch(/^Not booked · hold until/);

    const [u] = await db.select().from(units).where(eq(units.id, unit.id));
    expect(u.lsWorkorderId).toBe("103");
    expect(u.lsSerializedId).toBe("102");
    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.lsCustomerId).toBe("101");
    const ev = await lastMessageEvent(unit.id);
    expect(ev.type).toBe("msg_bike_arrived");
    expect(ev.payload.lightspeed).toMatchObject({ workorderID: "103", workorderStatusID: STATUSES.bike_arrived, created: true });
    // Klaviyo still received the message
    expect(notifier.sent.map((s) => s.metric)).toEqual(["Pickup: Bike Arrived"]);
  });

  it("booking updates the existing work order with the slot as ETA Out and the Booked status", async () => {
    const ls = fakeLightspeed();
    setLightspeedFetch(ls.fetchImpl);
    const order = await makeOrder(db, showroom);
    const unit = await makeUnit(db, showroom, order.id);
    await inviteUnit(db, { showroom, unitId: unit.id, actor: "s", now: NOW });
    ls.calls.length = 0;

    await bookSlot(db, { showroom, unitId: unit.id, startsAt: localToUtc("2026-09-05", "11:45", TZ), createdBy: "customer", now: NOW });

    const put = ls.calls.find((c) => c.method === "PUT")!;
    expect(put.url).toMatch(/Workorder\/103\.json$/);
    expect(put.body).toMatchObject({
      workorderStatusID: STATUSES.booked,
      etaOut: localToUtc("2026-09-05", "11:45", TZ).toISOString(),
      // Sat 5 Sep pickup → build by Fri 4 Sep (last open day before), pickup time preserved
      hookOut: expect.stringMatching(/^BUILD BY: end of Fri 4 Sep · Pickup Saturday 11:45 am \(5 Sep\)$/),
    });
    expect(ls.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("a Lightspeed failure is recorded on the event and never fails the booking or Klaviyo", async () => {
    const ls = fakeLightspeed({ failWorkorder: true });
    setLightspeedFetch(ls.fetchImpl);
    const order = await makeOrder(db, showroom);
    const unit = await makeUnit(db, showroom, order.id);
    const { unit: invited } = await inviteUnit(db, { showroom, unitId: unit.id, actor: "s", now: NOW });
    expect(invited.status).toBe("invited");
    expect(notifier.sent).toHaveLength(1);
    const ev = await lastMessageEvent(unit.id);
    expect(ev.klaviyoStatus).toBe("sent");
    expect(String((ev.payload.lightspeed as Record<string, unknown>).error)).toMatch(/Workorder\.json → 500/);
  });

  it("refreshes and persists the rotated token pair on a 401", async () => {
    const ls = fakeLightspeed({ expireFirst: true });
    setLightspeedFetch(ls.fetchImpl);
    const order = await makeOrder(db, showroom);
    const unit = await makeUnit(db, showroom, order.id);
    await inviteUnit(db, { showroom, unitId: unit.id, actor: "s", now: NOW });

    expect(ls.calls.filter((c) => c.url.includes("/auth/oauth/token"))).toHaveLength(1);
    const [conn] = await db.select().from(lightspeedConnections);
    expect(decryptToken(conn.accessTokenEnc)).toBe("new-access");
    expect(decryptToken(conn.refreshTokenEnc)).toBe("new-refresh");
    const ev = await lastMessageEvent(unit.id);
    expect((ev.payload.lightspeed as Record<string, unknown>).created).toBe(true);
  });

  it("assembly mode: Due is 10:00 on the pickup day and the pickup time rides in Hook Out", async () => {
    const ls = fakeLightspeed();
    setLightspeedFetch(ls.fetchImpl);
    showroom = await withSettings(db, showroom, {
      lightspeed: { enabled: true, shop_id: 3, employee_id: 27, open_status_id: 1, due_mode: "assembly", assembly_due_time_local: "10:00", statuses: STATUSES },
    });
    const order = await makeOrder(db, showroom);
    const unit = await makeUnit(db, showroom, order.id);
    await inviteUnit(db, { showroom, unitId: unit.id, actor: "s", now: NOW });
    ls.calls.length = 0;
    // Saturday 14:45 pickup → due Saturday 10:00
    await bookSlot(db, { showroom, unitId: unit.id, startsAt: localToUtc("2026-09-05", "14:45", TZ), createdBy: "customer", now: NOW });
    let put = ls.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({
      etaOut: localToUtc("2026-09-05", "10:00", TZ).toISOString(),
      hookOut: expect.stringMatching(/^BUILD BY: Saturday 10:00 am \(5 Sep\) · Pickup Saturday 2:45 pm \(5 Sep\)$/),
    });
    const note = String(put.body!.note);
    expect(note).toContain("CUSTOMER PICKUP Saturday 5 September at 2:45 pm");
    expect(note.indexOf("BUILD BY: Saturday 5 September at 10:00 am")).toBeLessThan(note.indexOf("CUSTOMER PICKUP"));

    // An early slot (Tuesday 12:00 → before the 10:00 cut? no: 12:00 is after 10:00, so same day) vs a slot before 10:00 is impossible here (window opens 12:00);
    // so check the previous-open-day branch with a 10:00 due time and a Saturday 11:00 slot → still same day (11:00 > 10:00).
    ls.calls.length = 0;
    const order2 = await makeOrder(db, showroom);
    const unit2 = await makeUnit(db, showroom, order2.id);
    await inviteUnit(db, { showroom, unitId: unit2.id, actor: "s", now: NOW });
    showroom = await withSettings(db, showroom, {
      lightspeed: { enabled: true, shop_id: 3, employee_id: 27, open_status_id: 1, due_mode: "assembly", assembly_due_time_local: "16:00", statuses: STATUSES },
    });
    ls.calls.length = 0;
    // 16:00 due time with a Saturday 11:00 slot → falls back to the previous open day (Friday) at 16:00
    await bookSlot(db, { showroom, unitId: unit2.id, startsAt: localToUtc("2026-09-05", "11:00", TZ), createdBy: "customer", now: NOW });
    put = ls.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({ etaOut: localToUtc("2026-09-04", "16:00", TZ).toISOString() });
  });

  it("skips messages with no mapped status but still creates the work order for mapped ones", async () => {
    const ls = fakeLightspeed();
    setLightspeedFetch(ls.fetchImpl);
    showroom = await withSettings(db, showroom, {
      lightspeed: { enabled: true, shop_id: 3, employee_id: 27, open_status_id: 1, due_mode: "pickup", assembly_due_time_local: "10:00", statuses: { booked: 23 } },
    });
    const order = await makeOrder(db, showroom);
    const unit = await makeUnit(db, showroom, order.id);
    await inviteUnit(db, { showroom, unitId: unit.id, actor: "s", now: NOW });
    expect(ls.calls).toHaveLength(0);
    expect((await lastMessageEvent(unit.id)).payload.lightspeed).toMatchObject({ skipped: true });

    await bookSlot(db, { showroom, unitId: unit.id, startsAt: localToUtc("2026-09-05", "11:45", TZ), createdBy: "customer", now: NOW });
    const wo = ls.calls.find((c) => c.url.endsWith("Workorder.json"))!.body!;
    expect(wo).toMatchObject({ workorderStatusID: 1, etaOut: localToUtc("2026-09-05", "11:45", TZ).toISOString() });
    expect(ls.calls.find((c) => c.method === "PUT")!.body).toEqual({ workorderStatusID: 23 });
  });

  it("does nothing when the bridge is disabled", async () => {
    const ls = fakeLightspeed();
    setLightspeedFetch(ls.fetchImpl);
    showroom = await withSettings(db, showroom, {
      lightspeed: { enabled: false, shop_id: null, employee_id: null, open_status_id: 1, due_mode: "pickup", assembly_due_time_local: "10:00", statuses: {} },
    });
    const order = await makeOrder(db, showroom);
    const unit = await makeUnit(db, showroom, order.id);
    await inviteUnit(db, { showroom, unitId: unit.id, actor: "s", now: NOW });
    expect(ls.calls).toHaveLength(0);
    const ev = await lastMessageEvent(unit.id);
    expect(ev.payload.lightspeed).toBeUndefined();
  });
});
