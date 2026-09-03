import { describe, expect, it } from "vitest";
import { buildByDate, effectiveCapacity, slotStarts, slotsForDay, type OverrideLike, type RuleLike } from "@/lib/capacity";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { storageEstimateCents } from "@/lib/storage";
import { formatTime, localToUtc, toLocalDate } from "@/lib/time";

const TZ = "America/Vancouver";
const rules: RuleLike[] = [
  { weekday: 0, capacity: 0, windowStart: "12:00", windowEnd: "17:15", maxConcurrent: 1 },
  { weekday: 1, capacity: 0, windowStart: "12:00", windowEnd: "17:15", maxConcurrent: 1 },
  { weekday: 2, capacity: 3, windowStart: "12:00", windowEnd: "17:15", maxConcurrent: 1 },
  { weekday: 3, capacity: 3, windowStart: "12:00", windowEnd: "17:15", maxConcurrent: 1 },
  { weekday: 4, capacity: 3, windowStart: "12:00", windowEnd: "17:15", maxConcurrent: 1 },
  { weekday: 5, capacity: 3, windowStart: "12:00", windowEnd: "17:15", maxConcurrent: 1 },
  { weekday: 6, capacity: 6, windowStart: "11:00", windowEnd: "17:15", maxConcurrent: 1 },
];

describe("effectiveCapacity (§6.1)", () => {
  it("uses the weekday template", () => {
    const sat = effectiveCapacity("2026-09-12", rules, []);
    expect(sat.capacity).toBe(6);
    expect(sat.windowStart).toBe("11:00");
    expect(sat.closed).toBe(false);
    expect(effectiveCapacity("2026-09-13", rules, []).closed).toBe(true); // Sunday
  });

  it("override wins field by field, 0 = closed", () => {
    const overrides: OverrideLike[] = [
      { onDate: "2026-09-07", capacity: 0, windowStart: null, windowEnd: null, maxConcurrent: null, note: "Labour Day" },
      { onDate: "2026-09-12", capacity: 8, windowStart: null, windowEnd: null, maxConcurrent: 2 },
    ];
    expect(effectiveCapacity("2026-09-07", rules, overrides).closed).toBe(true);
    const sat = effectiveCapacity("2026-09-12", rules, overrides);
    expect(sat.capacity).toBe(8);
    expect(sat.maxConcurrent).toBe(2);
    expect(sat.windowStart).toBe("11:00"); // inherited
  });
});

describe("slotStarts (R4, §6.4)", () => {
  it("last slot ends by window end", () => {
    const tue = effectiveCapacity("2026-09-08", rules, []);
    expect(slotStarts(tue, 45)).toEqual(["12:00", "12:45", "13:30", "14:15", "15:00", "15:45", "16:30"]);
    const sat = effectiveCapacity("2026-09-12", rules, []);
    expect(slotStarts(sat, 45)).toHaveLength(8);
  });

  it("handles a window not divisible by the slot length", () => {
    const day = { ...effectiveCapacity("2026-09-08", rules, []), windowEnd: "17:00" };
    expect(slotStarts(day, 45).at(-1)).toBe("15:45");
  });
});

describe("slotsForDay (§6.2)", () => {
  const invitedAt = localToUtc("2026-09-01", "10:00", TZ);
  const pickupBy = localToUtc("2026-09-22", "23:59:59", TZ);
  const base = {
    tz: TZ,
    settings: DEFAULT_SETTINGS,
    invitedAt,
    pickupBy,
    bookedCount: 0,
    bookedStarts: [] as Date[],
    storageEstimate: () => 0,
  };

  it("hides slots inside the lead time", () => {
    const now = localToUtc("2026-09-07", "13:00", TZ); // 48h → earliest 9 Sep 13:00
    const slots = slotsForDay("2026-09-09", effectiveCapacity("2026-09-09", rules, []), { ...base, now });
    expect(slots.filter((s) => s.available).map((s) => s.startLocal)).toEqual(["13:30", "14:15", "15:00", "15:45", "16:30"]);
    expect(slots[0].reason).toBe("too_early");
  });

  it("marks the day full when the counter reaches X", () => {
    const now = localToUtc("2026-09-01", "10:00", TZ);
    const slots = slotsForDay("2026-09-08", effectiveCapacity("2026-09-08", rules, []), { ...base, now, bookedCount: 3 });
    expect(slots.every((s) => s.reason === "day_full")).toBe(true);
  });

  it("disables a time at max_concurrent but leaves others open", () => {
    const now = localToUtc("2026-09-01", "10:00", TZ);
    const taken = localToUtc("2026-09-08", "12:45", TZ);
    const slots = slotsForDay("2026-09-08", effectiveCapacity("2026-09-08", rules, []), {
      ...base,
      now,
      bookedCount: 1,
      bookedStarts: [taken],
    });
    expect(slots.find((s) => s.startLocal === "12:45")?.reason).toBe("time_full");
    expect(slots.find((s) => s.startLocal === "13:30")?.available).toBe(true);
  });

  it("returns nothing beyond the horizon or on closed days", () => {
    const now = localToUtc("2026-09-01", "10:00", TZ);
    expect(slotsForDay("2026-10-14", effectiveCapacity("2026-10-14", rules, []), { ...base, now })).toEqual([]); // 43 days
    expect(slotsForDay("2026-10-13", effectiveCapacity("2026-10-13", rules, []), { ...base, now }).length).toBeGreaterThan(0);
    expect(slotsForDay("2026-09-06", effectiveCapacity("2026-09-06", rules, []), { ...base, now })).toEqual([]);
  });

  it("flags storage on days past pick-up-by with the projected amount", () => {
    const now = localToUtc("2026-09-01", "10:00", TZ);
    const settings = { ...DEFAULT_SETTINGS, storage_fee_enabled: true };
    const unit = { storageFrom: null, pickupBy };
    const slots = slotsForDay("2026-09-25", effectiveCapacity("2026-09-25", rules, []), {
      ...base,
      now,
      settings,
      storageEstimate: (d) => storageEstimateCents(unit, 2, settings, d, TZ),
    });
    expect(slots[0].storageApplies).toBe(true);
    expect(slots[0].storageEstimateCents).toBe(3000); // 23rd, 24th, 25th
    expect(storageEstimateCents(unit, 1, settings, "2026-09-25", TZ)).toBe(0); // terms v1 never pays
    expect(storageEstimateCents(unit, 2, settings, "2026-12-01", TZ)).toBe(15000); // capped
  });

  it("keeps local wall-clock times across the DST fall-back", () => {
    const now = localToUtc("2026-10-20", "10:00", TZ);
    const inv = localToUtc("2026-10-20", "10:00", TZ);
    const pb = localToUtc("2026-11-10", "23:59:59", TZ);
    // Sunday 1 Nov 2026 is the fall-back day; open Tuesday 3 Nov must still read 12:00–16:30.
    const slots = slotsForDay("2026-11-03", effectiveCapacity("2026-11-03", rules, []), {
      ...base,
      now,
      invitedAt: inv,
      pickupBy: pb,
    });
    expect(formatTime(slots[0].startsAt, TZ)).toBe("12:00 pm");
    expect(toLocalDate(slots[0].startsAt, TZ)).toBe("2026-11-03");
    expect(slots[0].startsAt.toISOString()).toBe("2026-11-03T20:00:00.000Z"); // PST = UTC-8
    const before = slotsForDay("2026-10-27", effectiveCapacity("2026-10-27", rules, []), { ...base, now, invitedAt: inv, pickupBy: pb });
    expect(before[0].startsAt.toISOString()).toBe("2026-10-27T19:00:00.000Z"); // PDT = UTC-7
  });
});

describe("buildByDate", () => {
  it("is the last open day before the appointment, honouring closed days and overrides", () => {
    expect(buildByDate("2026-09-08", rules, [])).toBe("2026-09-05"); // Tue → Sat
    expect(buildByDate("2026-09-12", rules, [])).toBe("2026-09-11"); // Sat → Fri
    const overrides: OverrideLike[] = [{ onDate: "2026-09-11", capacity: 0, windowStart: null, windowEnd: null, maxConcurrent: null }];
    expect(buildByDate("2026-09-12", rules, overrides)).toBe("2026-09-10");
  });
});
