import { describe, expect, it } from "vitest";
import { easterSunday, saskatchewanHolidays } from "@/lib/holidays";

describe("Saskatchewan holidays", () => {
  it("works out 2026 from the rules", () => {
    expect(saskatchewanHolidays(2026)).toEqual([
      { date: "2026-01-01", name: "New Year's Day" },
      { date: "2026-02-16", name: "Family Day" },
      { date: "2026-04-03", name: "Good Friday" },
      { date: "2026-05-18", name: "Victoria Day" },
      { date: "2026-07-01", name: "Canada Day" },
      { date: "2026-08-03", name: "Saskatchewan Day" },
      { date: "2026-09-07", name: "Labour Day" },
      { date: "2026-10-12", name: "Thanksgiving" },
      { date: "2026-11-11", name: "Remembrance Day" },
      { date: "2026-12-25", name: "Christmas Day" },
    ]);
  });

  it("handles the moving ones in other years", () => {
    const d = (y: number) => Object.fromEntries(saskatchewanHolidays(y).map((h) => [h.name, h.date]));
    // 2027: Easter 28 Mar → Good Friday 26 Mar; Victoria Day 24 May (24th is a Monday).
    expect(d(2027)).toMatchObject({ "Good Friday": "2027-03-26", "Victoria Day": "2027-05-24", "Family Day": "2027-02-15", Thanksgiving: "2027-10-11" });
    expect(easterSunday(2025)).toEqual({ month: 4, day: 20 });
    expect(easterSunday(2028)).toEqual({ month: 4, day: 16 });
  });
});
