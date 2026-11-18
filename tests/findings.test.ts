import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { findingRequests, findings, lsWorkorders } from "@/db/schema";
import { addFinding, answerFindings, changeAnswer, closeUnanswered, deleteDraft, markTakenOff, FindingError, loadJobFindings, NEEDS_OK_METRIC, requestByToken, sendFindings } from "@/lib/findings";
import { saveConnection, setLightspeedFetch } from "@/lib/lightspeed";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import type { ShowroomCtx } from "@/lib/showroom";
import { resetDb, testDb, withSettings } from "./helpers";

type Call = { method: string; url: string; body: Record<string, unknown> | null };
const STAFF = "11111111-1111-4111-8111-111111111111";
const ROTOR = { itemId: "77", name: "Rear rotor 180 mm", qty: 1, price: 65, minutes: 15 };
const CHAIN = { itemId: "88", name: "Chain", qty: 1, price: 40, minutes: null };

function fakeLightspeed(opts: { refuse?: string } = {}) {
  const calls: Call[] = [];
  setLightspeedFetch(async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init?.method ?? "GET", url, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (/Customer\/9020\.json/.test(url)) return json(200, { Customer: { customerID: "9020", firstName: "Ahmed", lastName: "Ali", Contact: { Phones: { ContactPhone: { number: "604-555-0101", useType: "Mobile" } } } } });
    if (/Workorder\/\d+\/WorkorderItem\.json$/.test(url)) return String(body?.itemID) === opts.refuse ? json(400, { message: "no stock" }) : json(200, { WorkorderItem: { workorderItemID: "1" } });
    return json(404, { message: "unhandled" });
  });
  return calls;
}

describe("findings: extra work the customer approves", () => {
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
    await saveConnection(db, { accountId: "999", accessToken: "acc", refreshToken: "ref", expiresIn: 3600 });
    van = await withSettings(db, van, { lightspeed: { ...van.settings.lightspeed, enabled: true, shop_id: 3 } });
    await db.delete(lsWorkorders);
    await db.insert(lsWorkorders).values({ id: "10237", showroomId: van.id, statusId: 1, customerId: "9020", customerName: "Ahmed Ali", item: "Stunner X", employeeId: "57" });
  });

  it("a draft needs items, a reason and a level; drafts can be removed before they're sent", async () => {
    const base = { showroomId: van.id, workorderId: "10237", level: 3, why: "Worn past its limit.", items: [ROTOR], photos: [], actor: STAFF };
    await expect(addFinding(db, { ...base, items: [] })).rejects.toThrow(FindingError);
    await expect(addFinding(db, { ...base, why: " " })).rejects.toThrow(/why/);
    await expect(addFinding(db, { ...base, level: 4 })).rejects.toThrow(/strongly/);
    const f = await addFinding(db, base);
    await deleteDraft(db, { showroomId: van.id, findingId: f.id });
    expect((await loadJobFindings(db, "10237")).findings).toHaveLength(0);
  });

  it("Send texts one link for all drafts; yes adds the lines to Lightspeed, no doesn't; answers can't change twice", async () => {
    const calls = fakeLightspeed();
    const rotor = await addFinding(db, { showroomId: van.id, workorderId: "10237", level: 3, why: "Rotor worn.", items: [ROTOR], photos: [], actor: STAFF });
    const chain = await addFinding(db, { showroomId: van.id, workorderId: "10237", level: 1, why: "Chain stretched.", items: [CHAIN], photos: [], actor: STAFF });
    const sent = await sendFindings(db, { showroom: van, jobId: "w:10237", actor: STAFF, smsConsent: true });
    expect(sent).toMatchObject({ count: 2, told: "sent" });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({ metric: NEEDS_OK_METRIC, profile: { phone: expect.stringContaining("604"), smsConsent: true }, properties: { first_name: "Ahmed", count: 2, total: "105.00", url: sent.url } });
    await expect(sendFindings(db, { showroom: van, jobId: "w:10237", actor: STAFF, smsConsent: true })).rejects.toThrow(/nothing to send/);

    const token = sent.url.split("/ok/")[1];
    const req = await requestByToken(db, token);
    expect(req?.findings.map((f) => f.id)).toEqual([rotor.id, chain.id]);
    expect(await requestByToken(db, "not-a-real-token-at-all-xx")).toBeNull();

    const r = await answerFindings(db, { requestId: req!.request.id, decisions: { [rotor.id]: "approved", [chain.id]: "declined" }, by: "customer", employeeId: "57" });
    expect(r).toEqual({ approved: 1, declined: 1, lsFailed: 0 });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toEqual([expect.objectContaining({ url: expect.stringMatching(/Workorder\/10237\/WorkorderItem\.json$/), body: expect.objectContaining({ itemID: 77, employeeID: 57 }) })]);
    const again = await answerFindings(db, { requestId: req!.request.id, decisions: { [rotor.id]: "approved", [chain.id]: "approved" }, by: "customer" });
    expect(again).toEqual({ approved: 0, declined: 0, lsFailed: 0 });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    const [rq] = await db.select().from(findingRequests).where(eq(findingRequests.id, req!.request.id));
    expect(rq.answeredAt).not.toBeNull();
    const [saved] = await db.select().from(findings).where(eq(findings.id, rotor.id));
    expect(saved).toMatchObject({ decision: "approved", decidedBy: "customer", lsAdded: true, lsError: null });
  });

  it("a line Lightspeed refuses is kept on the finding; Mark ready hands over what's unanswered", async () => {
    fakeLightspeed({ refuse: "77" });
    const rotor = await addFinding(db, { showroomId: van.id, workorderId: "10237", level: 2, why: "Rotor worn.", items: [ROTOR], photos: [], actor: STAFF });
    const chain = await addFinding(db, { showroomId: van.id, workorderId: "10237", level: 1, why: "Chain.", items: [CHAIN], photos: [], actor: STAFF });
    const sent = await sendFindings(db, { showroom: van, jobId: "w:10237", actor: STAFF, smsConsent: false });
    const req = await requestByToken(db, sent.url.split("/ok/")[1]);
    const r = await answerFindings(db, { requestId: req!.request.id, decisions: { [rotor.id]: "approved" }, by: STAFF });
    expect(r.lsFailed).toBe(1);
    expect((await db.select().from(findings).where(eq(findings.id, rotor.id)))[0].lsError).toMatch(/Rear rotor/);
    expect(await closeUnanswered(db, { workorderId: "10237", by: STAFF })).toBe(1);
    expect((await db.select().from(findings).where(eq(findings.id, chain.id)))[0].decision).toBe("not_asked");
  });

  it("answers can change either way: no → yes adds the lines once; yes → no leaves them for staff to take off", async () => {
    const calls = fakeLightspeed();
    const rotor = await addFinding(db, { showroomId: van.id, workorderId: "10237", level: 3, why: "Rotor worn.", items: [ROTOR], photos: [], actor: STAFF });
    const chain = await addFinding(db, { showroomId: van.id, workorderId: "10237", level: 1, why: "Chain.", items: [CHAIN], photos: [], actor: STAFF });
    const sent = await sendFindings(db, { showroom: van, jobId: "w:10237", actor: STAFF, smsConsent: false });
    const req = await requestByToken(db, sent.url.split("/ok/")[1]);
    await answerFindings(db, { requestId: req!.request.id, decisions: { [rotor.id]: "declined" }, by: "customer" });
    const posts = () => calls.filter((c) => c.method === "POST").length;
    expect(posts()).toBe(0);
    // Unanswered, another job's id, or already that answer: nothing changes.
    expect((await changeAnswer(db, { findingId: chain.id, workorderId: "10237", to: "approved", by: "customer" })).changed).toBe(false);
    expect((await changeAnswer(db, { findingId: rotor.id, workorderId: "other", to: "approved", by: "customer" })).changed).toBe(false);
    expect((await changeAnswer(db, { findingId: rotor.id, workorderId: "10237", to: "declined", by: "customer" })).changed).toBe(false);

    expect(await changeAnswer(db, { findingId: rotor.id, workorderId: "10237", to: "approved", by: "customer", employeeId: "57" })).toEqual({ changed: true, lsFailed: false, takeOff: false });
    expect(posts()).toBe(1);
    expect(await changeAnswer(db, { findingId: rotor.id, workorderId: "10237", to: "declined", by: "customer" })).toEqual({ changed: true, lsFailed: false, takeOff: true });
    // Back to yes before staff took the lines off: they're still there, so nothing is added again.
    await changeAnswer(db, { findingId: rotor.id, workorderId: "10237", to: "approved", by: "customer" });
    expect(posts()).toBe(1);
    await changeAnswer(db, { findingId: rotor.id, workorderId: "10237", to: "declined", by: "customer" });
    await markTakenOff(db, { findingId: rotor.id, showroomId: van.id, by: STAFF });
    expect((await db.select().from(findings).where(eq(findings.id, rotor.id)))[0]).toMatchObject({ decision: "declined", lsAdded: false });
  });

  it("with no phone or email the link is still made, to copy and send by hand", async () => {
    fakeLightspeed();
    await db.update(lsWorkorders).set({ customerId: null }).where(eq(lsWorkorders.id, "10237"));
    await addFinding(db, { showroomId: van.id, workorderId: "10237", level: 2, why: "Rotor worn.", items: [ROTOR], photos: [], actor: STAFF });
    const sent = await sendFindings(db, { showroom: van, jobId: "w:10237", actor: STAFF, smsConsent: true });
    expect(sent.told).toBe("no_contact");
    expect(notifier.sent).toHaveLength(0);
    expect((await loadJobFindings(db, "10237")).requests[0].url).toBe(sent.url);
  });
});
