import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { events, units } from "@/db/schema";
import { bookSlot, recordNoShow } from "@/lib/booking";
import { runClock } from "@/lib/clock";
import { attributeReports, summarise, syncDeliveryReports, type DeliveryFeed, type DeliveryReport } from "@/lib/delivery";
import { inviteStatus, type MessageInfo } from "@/lib/invite-status";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import { MemorySlack, setSlackPoster, unbookedPingMessage } from "@/lib/slack";
import { validateSettings, DEFAULT_SETTINGS } from "@/lib/settings";
import type { ShowroomCtx } from "@/lib/showroom";
import { localToUtc } from "@/lib/time";
import { inviteUnit } from "@/lib/units";
import { makeOrder, makeUnit, resetDb, testDb, TZ, withSettings } from "./helpers";

let db: Db;
let showroom: ShowroomCtx;
let notifier: MemoryNotifier;
let slack: MemorySlack;
const INVITE = localToUtc("2026-09-01", "10:00", TZ);
const HOOK = "https://hooks.slack.com/services/T000/B000/XXXX";
const at = (d: string, t = "07:00") => localToUtc(d, t, TZ);
const clock = (d: string, t?: string) => runClock(db, { now: at(d, t), skipSpecialOrders: true, deliveryFeed: null });

async function invitedUnit(overrides: Parameters<typeof makeOrder>[2] = {}) {
  const order = await makeOrder(db, showroom, { customerName: "Pat Rider", ...overrides });
  const unit = await makeUnit(db, showroom, order.id);
  return (await inviteUnit(db, { showroom, unitId: unit.id, actor: "s", now: INVITE })).unit;
}

beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  setSlackPoster(null);
  await db.$client.end();
});
beforeEach(async () => {
  showroom = await resetDb(db);
  notifier = new MemoryNotifier();
  setNotifier(notifier);
  slack = new MemorySlack();
  setSlackPoster(slack);
});

describe("customer follow-up cadence", () => {
  it("sends the nudges on the configured days", async () => {
    showroom = await withSettings(db, showroom, { nudge_first_days: 2, nudge_second_days: 5, hold_ending_days: 0 });
    await invitedUnit();
    notifier.sent = [];
    for (const d of ["2026-09-03", "2026-09-04", "2026-09-06", "2026-09-15"]) await clock(d);
    expect(notifier.sent.map((s) => s.metric)).toEqual(["Pickup: Nudge Day 3", "Pickup: Nudge Day 7"]);
    expect(notifier.sent.map((s) => s.properties.days_since_invite)).toEqual([2, 5]);
  });

  it("rejects nudges out of order", () => {
    expect(validateSettings({ ...DEFAULT_SETTINGS, nudge_first_days: 7, nudge_second_days: 3 })).toContain(
      "Customer nudges must be in order: first nudge, then second nudge, then hold ending.",
    );
    expect(validateSettings({ ...DEFAULT_SETTINGS, nudge_first_days: 0, nudge_second_days: 3 })).toEqual([]);
  });

  it("follows up a no-show once, N days later, only while they haven't rebooked", async () => {
    const unit = await invitedUnit();
    await bookSlot(db, { showroom, unitId: unit.id, startsAt: at("2026-09-08", "12:00"), createdBy: "customer", now: INVITE });
    await recordNoShow(db, { showroom, unitId: unit.id, actor: "s", now: at("2026-09-08", "18:00") });
    notifier.sent = [];
    await clock("2026-09-10");
    expect(notifier.sent.filter((s) => s.metric === "Pickup: Missed Follow-up")).toHaveLength(0);
    await clock("2026-09-11");
    await clock("2026-09-12");
    const follow = notifier.sent.filter((s) => s.metric === "Pickup: Missed Follow-up");
    expect(follow).toHaveLength(1);
    expect(follow[0].properties.slot_start_local).toBe("Tuesday 8 September at 12:00 pm");
  });

  it("reminds about storage every N days, once per period", async () => {
    showroom = await withSettings(db, showroom, { storage_fee_enabled: true });
    await invitedUnit();
    notifier.sent = [];
    await clock("2026-09-23"); // storage starts (pick-up-by + 1)
    for (const d of ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-07"]) await clock(d);
    const reminders = notifier.sent.filter((s) => s.metric === "Pickup: Storage Reminder");
    expect(reminders.map((r) => r.properties.storage_days)).toEqual([7, 14]);
  });
});

describe("Slack ping to the store", () => {
  it("posts one message per customer, N days after the original invite, and never again", async () => {
    showroom = await withSettings(db, showroom, { slack_webhook_url: HOOK });
    await invitedUnit();
    await clock("2026-09-07");
    expect(slack.posted).toHaveLength(0);
    await clock("2026-09-08"); // day 7
    expect(slack.posted).toHaveLength(1);
    expect(slack.posted[0].webhookUrl).toBe(HOOK);
    expect(slack.posted[0].message.text).toContain("Pat Rider hasn't booked — invited 7 days ago");
    await clock("2026-09-09");
    await clock("2026-09-15");
    expect(slack.posted).toHaveLength(1);
  });

  it("skips customers who booked, and stores without Slack", async () => {
    const unit = await invitedUnit();
    await clock("2026-09-08");
    expect(slack.posted).toHaveLength(0); // no webhook yet
    showroom = await withSettings(db, showroom, { slack_webhook_url: HOOK, clock_last_run_date: null });
    await bookSlot(db, { showroom, unitId: unit.id, startsAt: at("2026-09-10", "12:00"), createdBy: "customer", now: at("2026-09-08", "08:00") });
    await clock("2026-09-09");
    expect(slack.posted).toHaveLength(0);
  });

  it("retries the next day when Slack refuses the post", async () => {
    showroom = await withSettings(db, showroom, { slack_webhook_url: HOOK });
    await invitedUnit();
    slack.failNext = 1;
    const [summary] = await clock("2026-09-08");
    expect(summary.counts.staffPingFailed).toBe(1);
    expect(await db.select().from(events).where(eq(events.type, "staff_pinged"))).toHaveLength(0);
    await clock("2026-09-09");
    expect(slack.posted).toHaveLength(1);
    expect(slack.posted[0].message.text).toContain("invited 8 days ago");
  });

  it("escapes customer text in the message", () => {
    const m = unbookedPingMessage({ store: "Vancouver", customer: "A <b> & C", phone: null, email: null, bike: "X", boxTag: "1", days: 7, invitedOn: "Tue", inviteStatus: "Sent", url: "https://x" });
    const text = (m.blocks![0] as { text: { text: string } }).text.text;
    expect(text).toContain("A &lt;b&gt; &amp; C");
    expect(text).toContain("no phone or email");
  });
});

describe("invite status", () => {
  const unit = { invitedAt: INVITE, linkOpenedAt: null };
  const msg = (over: Partial<MessageInfo> = {}): MessageInfo => ({ metric: "Pickup: Bike Arrived", klaviyoStatus: "sent", createdAt: INVITE, ...over });
  const d = (summary: "delivered" | "undelivered" | "pending", extra = {}) => ({ summary, final: summary !== "pending", checked_at: "", ...extra });

  it("ranks opened > delivered > not delivered > sent > failed", () => {
    expect(inviteStatus({ ...unit, linkOpenedAt: INVITE }, [msg()])?.key).toBe("opened");
    expect(inviteStatus(unit, [msg({ delivery: d("undelivered") }), msg({ delivery: d("delivered", { sms: { status: "delivered", at: "" } }) })])?.key).toBe("delivered");
    expect(inviteStatus(unit, [msg({ delivery: d("undelivered", { sms: { status: "failed", at: "", reason: "Invalid number" } }) })])).toMatchObject({ key: "undelivered", tone: "danger" });
    expect(inviteStatus(unit, [msg({ delivery: d("undelivered") }), msg({ createdAt: new Date(INVITE.getTime() + 1000) })])?.key).toBe("sent");
    expect(inviteStatus(unit, [msg({ klaviyoStatus: "failed", error: "no contact details" })])).toMatchObject({ key: "failed", detail: "Not sent — no contact details" });
    expect(inviteStatus(unit, [])?.key).toBe("none");
    expect(inviteStatus({ invitedAt: null, linkOpenedAt: null }, [])).toBeNull();
  });

  it("ignores messages from before this invite", () => {
    expect(inviteStatus(unit, [msg({ createdAt: new Date(INVITE.getTime() - 86_400_000), delivery: d("delivered", { sms: { status: "delivered", at: "" } }) })])?.key).toBe("none");
  });
});

describe("delivery reports", () => {
  let base = INVITE;
  const t = (min: number) => new Date(base.getTime() + min * 60_000);
  const rep = (min: number, channel: "sms" | "email", status: DeliveryReport["status"], reason?: string): DeliveryReport => ({ channel, status, at: t(min), reason });

  it("pairs each report with the message sent just before it", () => {
    const found = attributeReports([{ id: "b", createdAt: t(60) }, { id: "a", createdAt: t(0) }], [rep(1, "sms", "delivered"), rep(61, "sms", "failed", "Invalid number")]);
    expect(found.get("a")?.sms?.status).toBe("delivered");
    expect(found.get("b")?.sms?.reason).toBe("Invalid number");
  });

  it("waits for expected channels, but not forever", () => {
    const now = t(30);
    expect(summarise({ sms: rep(1, "sms", "failed") }, { sms: true, email: true }, 30 * 60_000, now)).toMatchObject({ summary: "pending", final: false });
    expect(summarise({ sms: rep(1, "sms", "failed") }, { sms: true, email: true }, 3 * 3_600_000, now)).toMatchObject({ summary: "undelivered", final: false });
    expect(summarise({ sms: rep(1, "sms", "failed"), email: rep(2, "email", "delivered") }, { sms: true, email: true }, 60_000, now)).toMatchObject({ summary: "delivered", final: true });
    expect(summarise({}, { sms: true, email: false }, 25 * 3_600_000, now)).toMatchObject({ summary: "pending", final: true });
  });

  it("stores the carrier result on the invite event", async () => {
    const unit = await invitedUnit({ smsConsent: true, customerEmail: null });
    // The event row is stamped with the real clock, so report times are relative to it.
    base = (await db.select().from(events).where(eq(events.type, "msg_bike_arrived")))[0].createdAt;
    const feed: DeliveryFeed = {
      findProfile: async ({ phone }) => (phone === "+16045550100" ? "P1" : null),
      reports: async () => [{ channel: "sms", status: "failed", at: t(1), reason: "Invalid number" }],
    };
    const res = await syncDeliveryReports(db, { now: t(10), feed });
    expect(res).toMatchObject({ customers: 1, updated: 1, errors: 0 });
    const [invite] = await db.select().from(events).where(eq(events.type, "msg_bike_arrived"));
    expect((invite.payload as { delivery: unknown }).delivery).toMatchObject({ summary: "undelivered", final: true, sms: { status: "failed", reason: "Invalid number" } });
    // Final: not checked again.
    expect((await syncDeliveryReports(db, { now: t(20), feed })).customers).toBe(0);
    const [u] = await db.select().from(units).where(eq(units.id, unit.id));
    expect(u.linkOpenedAt).toBeNull();
  });
});
