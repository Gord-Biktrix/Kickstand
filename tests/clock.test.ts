import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { events, units } from "@/db/schema";
import { bookSlot } from "@/lib/booking";
import { runClock } from "@/lib/clock";
import { MemoryNotifier, setNotifier } from "@/lib/notifier";
import { getShowroom, type ShowroomCtx } from "@/lib/showroom";
import { localToUtc } from "@/lib/time";
import { inviteUnit } from "@/lib/units";
import { makeOrder, makeUnit, resetDb, testDb, TZ, withSettings } from "./helpers";

let db: Db;
let showroom: ShowroomCtx;
let notifier: MemoryNotifier;
const INVITE = localToUtc("2026-09-01", "10:00", TZ);

async function invitedUnit(termsVersion = 2) {
  const order = await makeOrder(db, showroom, { termsVersion });
  const unit = await makeUnit(db, showroom, order.id);
  return (await inviteUnit(db, { showroom, unitId: unit.id, actor: "s", now: INVITE })).unit;
}

beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.$client.end();
});
beforeEach(async () => {
  showroom = await resetDb(db);
  notifier = new MemoryNotifier();
  setNotifier(notifier);
});

describe("clock job (§8)", () => {
  it("sends nudges on days 3, 7, 14 and never twice for the same day", async () => {
    await invitedUnit();
    notifier.sent = [];
    const at = (d: string) => localToUtc(d, "07:00", TZ);

    await runClock(db, { now: at("2026-09-02") });
    expect(notifier.sent).toHaveLength(0);

    await runClock(db, { now: at("2026-09-04") }); // day 3
    expect(notifier.sent.map((s) => s.metric)).toEqual(["Pickup: Nudge Day 3"]);
    expect(notifier.sent[0].properties.remaining_saturday_display).toBe("6 of 6");

    // Replay the same day: the last-run marker and dedupe both block a second send.
    await runClock(db, { now: at("2026-09-04") });
    await runClock(db, { now: at("2026-09-04"), forceDaily: true });
    expect(notifier.sent).toHaveLength(1);

    await runClock(db, { now: at("2026-09-08") }); // day 7
    await runClock(db, { now: at("2026-09-15") }); // day 14
    expect(notifier.sent.map((s) => s.metric)).toEqual(["Pickup: Nudge Day 3", "Pickup: Nudge Day 7", "Pickup: Hold Ending"]);
    const fresh = await getShowroom(db);
    expect(fresh.settings.clock_last_run_date).toBe("2026-09-15");
  });

  it("runs the daily actions once per local date, at or after the configured hour", async () => {
    await invitedUnit();
    notifier.sent = [];
    // Before the run hour: nothing.
    let [summary] = await runClock(db, { now: localToUtc("2026-09-04", "06:00", TZ) });
    expect(summary.ranDaily).toBe(false);
    expect(notifier.sent).toHaveLength(0);
    // A late tick (scheduler delayed past 7 am) still runs the day once.
    [summary] = await runClock(db, { now: localToUtc("2026-09-04", "09:00", TZ) });
    expect(summary.ranDaily).toBe(true);
    expect(notifier.sent).toHaveLength(1);
    // The next tick the same day does not repeat it.
    [summary] = await runClock(db, { now: localToUtc("2026-09-04", "10:00", TZ) });
    expect(summary.ranDaily).toBe(false);
    expect(notifier.sent).toHaveLength(1);
  });

  it("starts storage the day after pick-up-by for terms v2 only, when enabled", async () => {
    showroom = await withSettings(db, showroom, { storage_fee_enabled: true });
    const v2 = await invitedUnit(2);
    const v1 = await invitedUnit(1);
    notifier.sent = [];
    await runClock(db, { now: localToUtc("2026-09-22", "07:00", TZ) });
    let [u] = await db.select().from(units).where(eq(units.id, v2.id));
    expect(u.storageFrom).toBeNull();
    await runClock(db, { now: localToUtc("2026-09-23", "07:00", TZ) });
    [u] = await db.select().from(units).where(eq(units.id, v2.id));
    expect(u.storageFrom?.toISOString()).toBe(localToUtc("2026-09-23", "00:00", TZ).toISOString());
    const [old] = await db.select().from(units).where(eq(units.id, v1.id));
    expect(old.storageFrom).toBeNull();
    const started = notifier.sent.filter((s) => s.metric === "Pickup: Storage Started");
    expect(started).toHaveLength(1);
    expect(started[0].properties.storage_due_display).toBe("$10.00");
  });

  it("sends the day-before reminder at 17:00 local, once per appointment", async () => {
    const unit = await invitedUnit();
    await bookSlot(db, { showroom, unitId: unit.id, startsAt: localToUtc("2026-09-08", "12:00", TZ), createdBy: "customer", now: INVITE });
    notifier.sent = [];
    await runClock(db, { now: localToUtc("2026-09-07", "16:00", TZ) });
    expect(notifier.sent).toHaveLength(0);
    await runClock(db, { now: localToUtc("2026-09-07", "17:05", TZ) });
    await runClock(db, { now: localToUtc("2026-09-07", "17:40", TZ) });
    expect(notifier.sent.map((s) => s.metric)).toEqual(["Pickup: Reminder Day Before"]);
    expect(notifier.sent[0].properties.slot_start_local).toBe("Tuesday 8 September at 12:00 pm");
  });

  it("records failed sends on the event and does not retry them on replay", async () => {
    await invitedUnit();
    notifier.sent = [];
    notifier.failNext = 1;
    await runClock(db, { now: localToUtc("2026-09-04", "07:00", TZ) });
    const failed = await db.select().from(events).where(eq(events.klaviyoStatus, "failed"));
    expect(failed).toHaveLength(1);
    expect(failed[0].type).toBe("msg_nudge_day_3");
    await runClock(db, { now: localToUtc("2026-09-04", "07:00", TZ), forceDaily: true });
    expect(notifier.sent).toHaveLength(0);
  });
});
