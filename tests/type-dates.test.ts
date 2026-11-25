import { describe, expect, it } from "vitest";
import { datesLabel, typeNotEnded, validateBookingType, type BookingTypeInput } from "@/lib/booking-types";
import { typeSlots } from "@/lib/type-slots";

const HOURS = { "1": [["10:00", "12:00"]], "2": [["10:00", "12:00"]], "3": [["10:00", "12:00"]], "4": [["10:00", "12:00"]], "5": [["10:00", "12:00"]], "6": [["10:00", "12:00"]], "0": [["10:00", "12:00"]] } as Record<string, [string, string][]>;
const type = { durationMin: 60, bufferMin: 0, slotStepMin: 60, noticeMin: 0, horizonDays: 14, hours: HOURS };
const now = new Date("2026-11-25T08:00:00Z"); // Wed 00:00 Vancouver
const tz = "America/Vancouver";

describe("only these dates", () => {
  it("offers only the dates, even past the days-ahead limit", () => {
    const days = typeSlots({ type: { ...type, dateFrom: "2027-01-04", dateTo: "2027-01-06" }, tz, now, capacity: 1, busy: [] });
    expect(days.map((d) => d.date)).toEqual(["2027-01-04", "2027-01-05", "2027-01-06"]);
    expect(typeSlots({ type: { ...type, dateFrom: "2026-11-01", dateTo: "2026-11-20" }, tz, now, capacity: 1, busy: [] })).toEqual([]);
    expect(typeSlots({ type, tz, now, capacity: 1, busy: [] }).length).toBe(15);
  });

  it("checks the dates, clears them when off, and labels them", () => {
    const base: BookingTypeInput = { name: "Appreciation week", description: "", location: "in_person", access: "public", durationMin: 30, bufferMin: 0, slotStepMin: 30, noticeMin: 0, horizonDays: 60, capacityMode: "bench", benchCapacity: 1, hours: {}, useStoreHours: true, createsWorkOrder: false };
    expect(validateBookingType({ ...base, dateFrom: "2026-12-01", dateTo: "2026-12-07" }, "showroom")).toMatchObject({ dateFrom: "2026-12-01", dateTo: "2026-12-07" });
    expect(validateBookingType(base, "showroom")).toMatchObject({ dateFrom: null, dateTo: null });
    expect(() => validateBookingType({ ...base, dateFrom: "2026-12-07", dateTo: "2026-12-01" }, "showroom")).toThrow("before the first");
    expect(() => validateBookingType({ ...base, dateFrom: "", dateTo: "" }, "showroom")).toThrow("first and last date");
    expect(datesLabel({ dateFrom: "2026-12-01", dateTo: "2026-12-07" })).toBe("Dec 1–7");
    expect(datesLabel({ dateFrom: "2026-11-28", dateTo: "2026-12-04" })).toBe("Nov 28 – Dec 4");
    expect(datesLabel({ dateFrom: null, dateTo: null })).toBeNull();
    expect(typeNotEnded({ dateTo: "2026-11-24" }, "2026-11-25")).toBe(false);
    expect(typeNotEnded({ dateTo: "2026-11-25" }, "2026-11-25")).toBe(true);
    expect(typeNotEnded({ dateTo: null }, "2026-11-25")).toBe(true);
  });
});
