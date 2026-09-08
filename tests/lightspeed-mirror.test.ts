import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { events } from "@/db/schema";
import { bookGroup, cancelBooking, rescheduleBooking } from "@/lib/booking";
import { inviteUnit } from "@/lib/units";
import { localToUtc } from "@/lib/time";
import type { ShowroomCtx } from "@/lib/showroom";
import { makeOrder, makeUnit, resetDb, testDb } from "./helpers";

let db: Db;
let showroom: ShowroomCtx;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.$client.end(); });
beforeEach(async () => { showroom = await resetDb(db); });

const TZ = "America/Vancouver";
const NOW = new Date("2026-09-01T17:00:00Z");

/**
 * Regression for "booking from the Lightspeed button didn't create a work order": the mirror used to ride
 * on the customer message, so silent bookings (second bike of a visit, reschedules, staff cancels) never
 * reached Lightspeed. With the bridge off in tests we can't call Lightspeed, but we can assert that one
 * customer message per visit is still the rule (no extra texts leaked from the fix).
 */
describe("Lightspeed mirror is independent of customer messages", () => {
  it("a two-bike visit still sends exactly one Booked text, one Rescheduled text, one Cancelled text", async () => {
    const order = await makeOrder(db, showroom, { customerPhone: "+16045550100" });
    const a = await makeUnit(db, showroom, order.id);
    const b = await makeUnit(db, showroom, order.id);
    for (const u of [a, b]) await inviteUnit(db, { showroom, unitId: u.id, actor: "s", now: NOW, silent: true });
    await bookGroup(db, { showroom, unitIds: [a.id, b.id], startsAt: localToUtc("2026-09-08", "12:00", TZ), createdBy: "staff", now: NOW });
    const count = async (type: string) => (await db.select().from(events).where(and(eq(events.showroomId, showroom.id), like(events.type, type)))).length;
    expect(await count("msg_booked")).toBe(1);
    await rescheduleBooking(db, { showroom, unitId: a.id, startsAt: localToUtc("2026-09-09", "12:00", TZ), actor: "staff", now: NOW });
    expect(await count("msg_rescheduled")).toBe(1);
    expect(await count("msg_booked")).toBe(1);
    await cancelBooking(db, { showroom, unitId: b.id, reason: "staff", actor: "staff", now: NOW });
    expect(await count("msg_cancelled")).toBe(0); // staff cancels are silent for the customer …
    // … and with the bridge disabled in tests, no lightspeed_synced rows either (nothing to mirror to).
    expect(await count("lightspeed_synced")).toBe(0);
  });
});
