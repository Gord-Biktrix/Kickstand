import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { monthCells } from "@/components/booking-calendar";
import { colorOf, createBookingType, effectiveHours, ensureDefaultBookingTypes, ensureStoreHours, hoursFromForm, listBookingTypes, setStoreHours, validateBookingType, WEEKDAY_8_TO_4 } from "@/lib/booking-types";
import { getShowroomById, type ShowroomCtx } from "@/lib/showroom";
import { createShowroom } from "@/lib/showroom-admin";
import { localToUtc } from "@/lib/time";
import { getTypeAvailability } from "@/lib/type-slots";
import { resetDb, testDb } from "./helpers";

describe("hours editor and calendar helpers", () => {
  it("reads the hours grid: ticked days only, optional second range, clear errors", () => {
    const form: Record<string, string> = { day_1: "on", s1_1: "09:00", e1_1: "12:00", s2_1: "13:00", e2_1: "17:00", day_2: "on", s1_2: "10:00", e1_2: "16:00", s1_3: "09:00", e1_3: "17:00" };
    expect(hoursFromForm((k) => form[k] ?? "")).toEqual({ "1": [["09:00", "12:00"], ["13:00", "17:00"]], "2": [["10:00", "16:00"]] });
    expect(() => hoursFromForm((k) => ({ day_4: "on", s1_4: "17:00", e1_4: "09:00" } as Record<string, string>)[k] ?? "")).toThrow(/^Thursday: .*ends before/);
    expect(() => hoursFromForm((k) => ({ day_5: "on" } as Record<string, string>)[k] ?? "")).toThrow(/^Friday: ticked but no times/);
  });

  it("uses the store's hours or the type's own", () => {
    const store = { "6": [["10:00", "14:00"]] as [string, string][] };
    expect(effectiveHours({ useStoreHours: true, hours: WEEKDAY_8_TO_4 }, store)).toEqual(store);
    expect(effectiveHours({ useStoreHours: false, hours: WEEKDAY_8_TO_4 }, store)).toEqual(WEEKDAY_8_TO_4);
    expect(colorOf("nope").hex).toBe(colorOf("blue").hex);
  });

  it("lays a month out from Sunday", () => {
    const nov = monthCells("2026-11"); // 1 Nov 2026 is a Sunday
    expect(nov[0]).toBe("2026-11-01");
    expect(nov.length).toBe(30);
    const dec = monthCells("2026-12"); // 1 Dec 2026 is a Tuesday
    expect(dec.slice(0, 3)).toEqual([null, null, "2026-12-01"]);
  });
});

describe("store availability", () => {
  let db: Db;
  let van: ShowroomCtx;
  const TZ = "America/Vancouver";
  const NOW = localToUtc("2026-11-16", "07:00", TZ); // Monday
  beforeAll(async () => { db = await testDb(); });
  afterAll(async () => { await db.$client.end(); });
  beforeEach(async () => { van = await resetDb(db); });

  it("starts from pickup times; default types follow it, so one change moves every type on store hours", async () => {
    await ensureDefaultBookingTypes(db, van);
    van = await getShowroomById(db, van.id);
    expect(van.bookingHours).toMatchObject({ "2": [["12:00", "17:15"]], "6": [["11:00", "17:15"]] });
    const types = await listBookingTypes(db, van.id);
    const ride = types.find((t) => t.slug === "test-ride")!;
    expect(ride.useStoreHours).toBe(true);
    expect(ride.color).toBe("blue");
    expect(types.find((t) => t.slug === "service")!.color).toBe("orange");
    // A custom-hours type ignores the store's hours.
    const late = await createBookingType(db, van.id, validateBookingType({ name: "Evening clinic", description: "", location: "in_person", access: "public", durationMin: 60, bufferMin: 0, slotStepMin: 60, noticeMin: 0, horizonDays: 30, capacityMode: "bench", benchCapacity: 1, hours: { "1": [["18:00", "20:00"]] }, createsWorkOrder: false, useStoreHours: false, color: "pink" }, "showroom"));
    await setStoreHours(db, van.id, { "1": [["09:00", "11:00"]] });
    van = await getShowroomById(db, van.id);
    const rideDays = await getTypeAvailability(db, { showroom: van, type: ride, now: NOW, from: "2026-11-23", to: "2026-11-23" });
    expect(rideDays[0].slots.map((s) => s.time)).toEqual(["09:00", "09:30", "10:00"]);
    const lateDays = await getTypeAvailability(db, { showroom: van, type: late, now: NOW, from: "2026-11-23", to: "2026-11-23" });
    expect(lateDays[0].slots.map((s) => s.time)).toEqual(["18:00", "19:00"]);
    await expect(setStoreHours(db, van.id, {})).rejects.toThrow(/at least one day/);
  });

  it("the online team starts Mon–Fri 8–4", async () => {
    const online = await createShowroom(db, { slug: "online", name: "Biktrix Online", kind: "online", timezone: TZ, addressLine: "", phone: null });
    expect(await ensureStoreHours(db, online)).toEqual(WEEKDAY_8_TO_4);
    expect((await listBookingTypes(db, online.id)).every((t) => t.useStoreHours)).toBe(true);
  });
});
