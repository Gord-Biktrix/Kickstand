import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { events, jobSheets } from "@/db/schema";
import { intakeFromForm, intakeRows, intakeSummary } from "@/lib/intake";
import { LineChangeError, loadJobSheet, removeLine, saveIntake, saveLineNote, setLinePrice } from "@/lib/job-sheet";
import { LightspeedClient, saveConnection, setLightspeedFetch } from "@/lib/lightspeed";
import type { ShowroomCtx } from "@/lib/showroom";
import { resetDb, testDb } from "./helpers";

const STAFF = "11111111-1111-4111-8111-111111111111";

describe("intake (the bike's condition at check-in)", () => {
  it("reads the form: odometer as whole km, only known choices, nothing filled in → null", () => {
    const form: Record<string, string> = { intake_odometer: "1,240.6", intake_chain: "p075", intake_brakes: "bleed", intake_pads: "melted", intake_key: "" };
    const i = intakeFromForm((k) => form[k] ?? "");
    expect(i).toEqual({ odometer: 1241, chain: "p075", brakes: "bleed" });
    expect(intakeRows(i)).toEqual([["Odometer", "1,241 km"], ["Chain wear", "0.75%"], ["Brakes", "Bleed"]]);
    expect(intakeSummary(i)).toBe("Odometer 1,241 km · Chain wear 0.75% · Brakes Bleed");
    expect(intakeFromForm(() => "")).toBeNull();
    expect(intakeFromForm((k) => (k === "intake_odometer" ? "abc" : ""))).toBeNull();
  });
});

describe("job sheet: condition, line notes, line changes", () => {
  let db: Db;
  let van: ShowroomCtx;
  let calls: { method: string; url: string; body: unknown }[];
  let refuseNested: boolean;

  beforeAll(async () => {
    db = await testDb();
    process.env.LS_CLIENT_ID ??= "test-client";
    process.env.LS_CLIENT_SECRET ??= "test-secret";
    process.env.AUTH_SECRET ??= "test-secret-for-tokens";
  });
  afterAll(async () => { setLightspeedFetch(null); await db.$client.end(); });
  beforeEach(async () => {
    van = await resetDb(db);
    await db.delete(jobSheets);
    calls = [];
    refuseNested = false;
    setLightspeedFetch(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
      if (refuseNested && /Workorder\/\d+\/Workorder(Item|Line)\//.test(url)) return json(405, { message: "Method not allowed" });
      if (/WorkorderItem\/999/.test(url)) return json(400, { message: "Item is on a completed sale" });
      return json(200, {});
    });
    await saveConnection(db, { accountId: "999", accessToken: "acc", refreshToken: "ref", expiresIn: 3600 });
  });

  it("saves the condition once per work order and replaces it on change", async () => {
    await saveIntake(db, { showroomId: van.id, workorderId: "10080", intake: { odometer: 900, chain: "ok" }, actor: STAFF });
    await saveIntake(db, { showroomId: van.id, workorderId: "10080", intake: { odometer: 950, pads: "low" }, actor: STAFF });
    const s = await loadJobSheet(db, "10080");
    expect(s?.intake).toEqual({ odometer: 950, pads: "low" });
    expect(await db.select().from(jobSheets)).toHaveLength(1);
  });

  it("keeps a note per line; saving another line keeps the first; empty text clears it", async () => {
    await saveLineNote(db, { showroomId: van.id, workorderId: "10080", lineId: "l55", text: "  Bled rear, DOT 5.1 ", actor: STAFF });
    await saveLineNote(db, { showroomId: van.id, workorderId: "10080", lineId: "i77", text: "Used 2 pads", actor: STAFF });
    let s = await loadJobSheet(db, "10080");
    expect(Object.fromEntries(Object.entries(s!.lineNotes).map(([k, v]) => [k, v.text]))).toEqual({ l55: "Bled rear, DOT 5.1", i77: "Used 2 pads" });
    await saveLineNote(db, { showroomId: van.id, workorderId: "10080", lineId: "l55", text: "", actor: STAFF });
    s = await loadJobSheet(db, "10080");
    expect(Object.keys(s!.lineNotes)).toEqual(["i77"]);
    await expect(saveLineNote(db, { showroomId: van.id, workorderId: "10080", lineId: "x1", text: "hi", actor: STAFF })).rejects.toThrow(LineChangeError);
  });

  it("removes a part under its work order, drops its note and logs it", async () => {
    await saveLineNote(db, { showroomId: van.id, workorderId: "10080", lineId: "i77", text: "Used 2 pads", actor: STAFF });
    await removeLine(db, new LightspeedClient(db), { showroomId: van.id, workorderId: "10080", lineId: "i77", label: "Brake pads", actor: STAFF });
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: expect.stringMatching(/\/Workorder\/10080\/WorkorderItem\/77\.json$/) });
    expect((await loadJobSheet(db, "10080"))?.lineNotes).toEqual({});
    expect((await db.select().from(events)).map((e) => e.type)).toContain("workorder_line_removed");
  });

  it("falls back to the line's own endpoint when the nested one is refused", async () => {
    refuseNested = true;
    await removeLine(db, new LightspeedClient(db), { showroomId: van.id, workorderId: "10080", lineId: "l55", label: "Tune up", actor: STAFF });
    expect(calls.map((c) => `${c.method} ${c.url.replace(/^.*Account\/999\//, "")}`)).toEqual(["DELETE Workorder/10080/WorkorderLine/55.json", "DELETE WorkorderLine/55.json"]);
  });

  it("changes a part's unitPrice and labour's unitPriceOverride; refuses $0 and says why Lightspeed refused", async () => {
    const client = new LightspeedClient(db);
    await setLinePrice(db, client, { showroomId: van.id, workorderId: "10080", lineId: "i77", label: "Pads", price: 39.999, was: 45, actor: STAFF });
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { unitPrice: 40 } });
    await setLinePrice(db, client, { showroomId: van.id, workorderId: "10080", lineId: "l55", label: "Tune up", price: 99, was: 120, actor: STAFF });
    expect(calls.at(-1)).toMatchObject({ method: "PUT", url: expect.stringMatching(/WorkorderLine\/55\.json$/), body: { unitPriceOverride: 99 } });
    await expect(setLinePrice(db, client, { showroomId: van.id, workorderId: "10080", lineId: "l55", label: "Tune up", price: 0, was: 120, actor: STAFF })).rejects.toThrow(/above \$0/);
    await expect(setLinePrice(db, client, { showroomId: van.id, workorderId: "10080", lineId: "i999", label: "Old", price: 5, was: 6, actor: STAFF })).rejects.toThrow(/completed sale/);
    await expect(removeLine(db, client, { showroomId: van.id, workorderId: "10080", lineId: "qc", label: "QC", actor: STAFF })).rejects.toThrow(LineChangeError);
  });
});
