import { describe, expect, it } from "vitest";
import { addOpenMinutes, benchLoads, estimateReady } from "@/lib/ready-estimate";
import { localToUtc } from "@/lib/time";

const TZ = "America/Vancouver";
const at = (d: string, t: string) => localToUtc(d, t, TZ);
// Mon–Sat 10:00–18:00 (2026-11-16 is a Monday).
const HOURS = Object.fromEntries([1, 2, 3, 4, 5, 6].map((d) => [String(d), [["10:00", "18:00"]] as [string, string][]]));
const job = (column: string, minutes: number, over: Partial<{ startBy: Date; readyBy: Date; notHereYet: boolean; noDate: boolean; kind: string }> = {}) => ({ column, minutes, startBy: at("2026-11-16", "12:00"), readyBy: at("2026-11-16", "15:00"), notHereYet: false, noDate: false, ...over });

describe("ready-by estimate", () => {
  it("shares the queue across benches, biggest jobs first; ignores parts waits, arrivals still to come and far-off jobs", () => {
    const now = at("2026-11-16", "12:00");
    const jobs = [job("todo", 120), job("todo", 60), job("todo", 30), job("parts", 300), job("todo", 90, { notHereYet: true }), job("todo", 60, { startBy: at("2026-11-20", "10:00") })];
    expect(benchLoads(jobs, 2, now)).toEqual([90, 120]);
    // Old work orders nobody closed, shop floor bikes and undated jobs don't block the bench.
    const noise = [job("todo", 60, { startBy: at("2026-04-30", "11:00"), readyBy: at("2026-04-30", "12:00") }), job("todo", 60, { kind: "floor" }), job("todo", 60, { noDate: true })];
    expect(benchLoads(noise, 2, now)).toEqual([0, 0]);
    // In progress counts only its time left: ready at 13:00, so 60 of its 90 minutes remain.
    expect(benchLoads([job("doing", 90, { readyBy: at("2026-11-16", "13:00") })], 1, now)).toEqual([60]);
  });

  it("only counts open hours, rolling past closing and closed days", () => {
    expect(addOpenMinutes(at("2026-11-16", "17:00"), 120, HOURS, TZ).toISOString()).toBe(at("2026-11-17", "11:00").toISOString());
    // Saturday 17:30 + 60 min → 30 min left over, Sunday closed → Monday 10:30.
    expect(addOpenMinutes(at("2026-11-21", "17:30"), 60, HOURS, TZ).toISOString()).toBe(at("2026-11-23", "10:30").toISOString());
    // Before opening, the clock starts at opening.
    expect(addOpenMinutes(at("2026-11-16", "08:00"), 30, HOURS, TZ).toISOString()).toBe(at("2026-11-16", "10:30").toISOString());
  });

  it("ready = after the freest bench's queue plus the work, rounded up to 15 minutes", () => {
    const now = at("2026-11-16", "12:05");
    expect(estimateReady({ now, work: 60, loads: [90, 120], hours: HOURS, tz: TZ }).toISOString()).toBe(at("2026-11-16", "14:45").toISOString());
    expect(estimateReady({ now, work: 60, loads: [0], hours: {}, tz: TZ }).toISOString()).toBe(at("2026-11-16", "13:15").toISOString());
  });
});
