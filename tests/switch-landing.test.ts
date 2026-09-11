import { describe, expect, it } from "vitest";
import { detailTarget, landingAfterSwitch } from "@/lib/showroom-select";

const UNIT = "/app/units/0b6c5e1e-9d2c-4b8e-9a1f-1234567890ab";

describe("landing after a store switch", () => {
  it("keeps list and settings pages — they exist in every store", () => {
    for (const p of ["/app", "/app/schedule?view=week", "/app/bikes?filter=booked", "/app/settings/capacity"]) {
      expect(landingAfterSwitch(p, false)).toBe(p);
    }
  });

  it("keeps a detail page when the record also lives in the new store", () => {
    expect(landingAfterSwitch(UNIT, true)).toBe(UNIT);
  });

  it("falls back to the section list when the record is not in the new store", () => {
    expect(landingAfterSwitch(UNIT, false)).toBe("/app/bikes");
    expect(landingAfterSwitch("/app/orders/abc", false)).toBe("/app/bikes");
    expect(landingAfterSwitch("/app/customers/ph%3A6045550100", false)).toBe("/app/search");
  });

  it("identifies the record a detail path points at", () => {
    expect(detailTarget(UNIT)).toEqual({ kind: "unit", id: "0b6c5e1e-9d2c-4b8e-9a1f-1234567890ab" });
    expect(detailTarget("/app/customers/ph%3A6045550100")).toEqual({ kind: "customer", id: "ph:6045550100" });
    expect(detailTarget("/app/bikes")).toBeNull();
  });
});
