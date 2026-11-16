import { describe, expect, it } from "vitest";
import { daysInZone, validTimeZone, viewZone } from "@/lib/view-tz";
import { typeSlots } from "@/lib/type-slots";
import { WEEKDAY_8_TO_4 } from "@/lib/booking-types";
import { localToUtc } from "@/lib/time";

const TZ = "America/Vancouver";
const NOW = localToUtc("2026-11-16", "07:00", TZ);
const call = { durationMin: 30, bufferMin: 0, slotStepMin: 30, noticeMin: 240, horizonDays: 3, hours: WEEKDAY_8_TO_4 };

describe("times in the customer's zone", () => {
  it("accepts real zones only", () => {
    expect(validTimeZone("America/Toronto")).toBe("America/Toronto");
    expect(validTimeZone("Mars/Base")).toBeNull();
    expect(validTimeZone("<script>")).toBeNull();
    expect(viewZone(undefined, TZ)).toBe(TZ);
  });

  it("relabels times and keeps the same instants", () => {
    const days = typeSlots({ type: call, tz: TZ, now: NOW, capacity: 1, busy: [] });
    const toronto = daysInZone(days, TZ, "America/Toronto");
    expect(toronto[1].slots[0].time).toBe("10:00"); // 8:00 Pacific (B.C. stays on UTC-7, Toronto falls back to UTC-5)
    expect(toronto[1].slots[0].startsAt.getTime()).toBe(days[1].slots[0].startsAt.getTime());
    expect(daysInZone(days, TZ, TZ)).toBe(days);
  });

  it("moves late slots onto the next day for zones far ahead", () => {
    const days = typeSlots({ type: call, tz: TZ, now: NOW, capacity: 1, busy: [] });
    // 8:00 Pacific on the 17th = 00:00 on the 18th in Tokyo (16 hours ahead).
    const tokyo = daysInZone(days, TZ, "Asia/Tokyo");
    const d18 = tokyo.find((d) => d.date === "2026-11-18")!;
    expect(d18.slots.slice(0, 3).map((s) => s.time)).toEqual(["00:00", "00:30", "01:00"]);
  });
});
