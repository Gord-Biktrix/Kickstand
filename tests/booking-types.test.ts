import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import {
  createBookingType,
  ensureDefaultBookingTypes,
  hoursFromCapacity,
  hoursSummary,
  listBookingTypes,
  NEW_TYPE_DEFAULTS,
  parseDayHours,
  parseWeeklyHours,
  presetsFor,
  setBookingTypeActive,
  updateBookingType,
  updatePickupType,
  validateBookingType,
  WEEKDAY_8_TO_4,
  type BookingTypeInput,
} from "@/lib/booking-types";
import type { ShowroomCtx } from "@/lib/showroom";
import { createShowroom } from "@/lib/showroom-admin";
import { canEditShowroom } from "@/lib/showroom-select";
import { resetDb, testDb } from "./helpers";

const base: BookingTypeInput = {
  name: "Test ride", description: "", location: "in_person", access: "public",
  durationMin: 45, bufferMin: 0, slotStepMin: 30, noticeMin: 240, horizonDays: 60,
  capacityMode: "bench", benchCapacity: 1, hours: WEEKDAY_8_TO_4, createsWorkOrder: false,
};

describe("booking type helpers", () => {
  it("parses the hours staff type", () => {
    expect(parseDayHours("8:00-16:00")).toEqual([["08:00", "16:00"]]);
    expect(parseDayHours("1pm-5pm, 9am-12pm")).toEqual([["09:00", "12:00"], ["13:00", "17:00"]]);
    expect(parseDayHours("  ")).toEqual([]);
    expect(() => parseDayHours("16:00-8:00")).toThrow(/ends before/);
    expect(() => parseDayHours("9-12, 11-13")).toThrow(/overlap/);
    expect(() => parseDayHours("noon")).toThrow(/time range/);
    expect(() => parseWeeklyHours(["", "9-5pm", "x"])).toThrow(/^Tue:/);
    expect(parseWeeklyHours(["", "8:00-16:00", "", "", "", "", ""])).toEqual({ "1": [["08:00", "16:00"]] });
  });

  it("summarises weekly hours, grouping runs of equal days", () => {
    expect(hoursSummary(WEEKDAY_8_TO_4)).toBe("Mon–Fri 08:00-16:00");
    expect(hoursSummary({ "2": [["12:00", "17:00"]], "6": [["11:00", "17:00"]] })).toBe("Tue 12:00-17:00 · Sat 11:00-17:00");
    expect(hoursSummary({})).toBe("No hours set");
  });

  it("validates a type, and the online team can't take in-person bookings", () => {
    expect(validateBookingType({ ...base, name: "  Test ride  " }, "showroom").name).toBe("Test ride");
    expect(() => validateBookingType({ ...base, name: "" }, "showroom")).toThrow(/name/);
    expect(() => validateBookingType(base, "online")).toThrow(/video or phone/);
    expect(() => validateBookingType({ ...base, durationMin: 2 }, "showroom")).toThrow(/Length/);
    expect(() => validateBookingType({ ...base, hours: {} }, "showroom")).toThrow(/hours/);
    // Only in-person bookings can create a work order.
    expect(validateBookingType({ ...base, location: "video", createsWorkOrder: true }, "showroom").createsWorkOrder).toBe(false);
    expect(presetsFor("online").map((p) => p.key)).toEqual(["video-call", "phone-call"]);
    expect(presetsFor("showroom").every((p) => p.location === "in_person")).toBe(true);
    expect(NEW_TYPE_DEFAULTS.durationMin).toBe(30);
  });

  it("lets staff edit their home store and any extra profile; others stay view-only", () => {
    const user = { role: "staff", showroomId: "van", extraShowroomIds: ["online"] };
    expect(canEditShowroom(user, { id: "van" })).toBe(true);
    expect(canEditShowroom(user, { id: "online" })).toBe(true);
    expect(canEditShowroom(user, { id: "calgary" })).toBe(false);
    expect(canEditShowroom({ role: "staff", showroomId: "van" }, { id: "online" })).toBe(false);
  });
});

describe("booking types in the database", () => {
  let db: Db;
  let vancouver: ShowroomCtx;
  beforeAll(async () => { db = await testDb(); });
  afterAll(async () => { await db.$client.end(); });
  beforeEach(async () => { vancouver = await resetDb(db); });

  it("every store works out of the box: showrooms get pickup + test ride, service, visit; the online team gets calls", async () => {
    const sk = await createShowroom(db, { slug: "", name: "Biktrix Saskatoon", timezone: "America/Regina", addressLine: "", phone: null, copyCapacityFrom: vancouver.slug });
    const skTypes = await listBookingTypes(db, sk.id);
    expect(skTypes.map((t) => [t.slug, t.access, t.active])).toEqual([["pickup", "invite", true], ["test-ride", "public", true], ["service", "public", true], ["showroom-visit", "public", true]]);
    // Hours come from the store's pickup days and times (Vancouver template: closed Sun/Mon, Sat from 11).
    const ride = skTypes.find((t) => t.slug === "test-ride")!;
    expect(ride.hours).toMatchObject({ "2": [["12:00", "17:15"]], "6": [["11:00", "17:15"]] });
    expect(ride.hours).not.toHaveProperty("0");
    expect(skTypes.find((t) => t.slug === "service")!.createsWorkOrder).toBe(true);
    const online = await createShowroom(db, { slug: "online", name: "Online sales", kind: "online", timezone: "America/Vancouver", addressLine: "ignored", phone: null });
    expect(online.kind).toBe("online");
    expect(online.addressLine).toBe("");
    const calls = await listBookingTypes(db, online.id);
    expect(calls.map((t) => [t.slug, t.location])).toEqual([["video-call", "video"], ["phone-call", "phone"]]);
    expect(calls[0].hours).toEqual(WEEKDAY_8_TO_4);
  });

  it("an existing store gets its defaults on first use, once; staff changes stick", async () => {
    expect((await listBookingTypes(db, vancouver.id)).map((t) => t.slug)).toEqual(["pickup"]);
    await ensureDefaultBookingTypes(db, vancouver);
    await ensureDefaultBookingTypes(db, vancouver);
    const types = await listBookingTypes(db, vancouver.id);
    expect(types.map((t) => t.slug)).toEqual(["pickup", "test-ride", "service", "showroom-visit"]);
    // Switched off and renamed: never re-added.
    const ride = types.find((t) => t.slug === "test-ride")!;
    await setBookingTypeActive(db, vancouver.id, ride.id, false);
    await updateBookingType(db, vancouver.id, ride.id, { ...base, name: "E-bike test ride" });
    await ensureDefaultBookingTypes(db, vancouver);
    expect((await listBookingTypes(db, vancouver.id)).length).toBe(4);
    expect(hoursFromCapacity([])).toEqual(WEEKDAY_8_TO_4);
  });

  it("creates, edits and switches off types per profile without touching other profiles", async () => {
    const online = await createShowroom(db, { slug: "online", name: "Online sales", kind: "online", timezone: "America/Vancouver", addressLine: "", phone: null });
    const call = await createBookingType(db, online.id, validateBookingType({ ...base, name: "Video call with an expert", location: "video" }, "online"));
    expect(call.slug).toBe("video-call-with-an-expert");  // the default is "video-call", so no clash
    const ride = await createBookingType(db, vancouver.id, base);
    const ride2 = await createBookingType(db, vancouver.id, base);
    expect(ride2.slug).toBe("test-ride-2");
    await updateBookingType(db, vancouver.id, ride.id, { ...base, name: "Long test ride", durationMin: 90 });
    const after = (await listBookingTypes(db, vancouver.id)).find((t) => t.id === ride.id)!;
    expect([after.slug, after.durationMin]).toEqual(["long-test-ride", 90]);
    // A type from another profile can't be edited from this one.
    await expect(updateBookingType(db, vancouver.id, call.id, base)).rejects.toThrow(/isn't in this store/);
    await setBookingTypeActive(db, vancouver.id, ride.id, false);
    expect((await listBookingTypes(db, vancouver.id)).find((t) => t.id === ride.id)!.active).toBe(false);
    // The pickup type only takes a name and description.
    const pickup = (await listBookingTypes(db, vancouver.id)).find((t) => t.kind === "pickup")!;
    await expect(updateBookingType(db, vancouver.id, pickup.id, base)).rejects.toThrow(/Capacity/);
    await updatePickupType(db, vancouver.id, pickup.id, { name: "Pick up your bike", description: "x" });
    expect((await listBookingTypes(db, vancouver.id)).find((t) => t.id === pickup.id)!.name).toBe("Pick up your bike");
    expect((await listBookingTypes(db, online.id)).map((t) => t.name)).toEqual(["Video call with an expert", "Phone call with an expert", "Video call with an expert"]);
  });
});
