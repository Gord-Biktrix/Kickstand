import { describe, expect, it } from "vitest";
import { cacheableBookingPage } from "@/lib/booking-cache";

const req = (path: string, method = "GET") => ({ method, nextUrl: new URL(`https://k.example${path}`) }) as Parameters<typeof cacheableBookingPage>[0];

describe("booking page CDN cache", () => {
  it("caches public booking pages, including month/day/time steps", () => {
    expect(cacheableBookingPage(req("/book/vancouver"))).toBe(true);
    expect(cacheableBookingPage(req("/book/vancouver/test-ride?month=2026-11&date=2026-11-17&time=10:00"))).toBe(true);
  });
  it("never caches personal or non-GET requests", () => {
    expect(cacheableBookingPage(req("/book/vancouver/test-ride?email=a@b.c"))).toBe(false);
    expect(cacheableBookingPage(req("/book/vancouver/test-ride?error=Taken"))).toBe(false);
    expect(cacheableBookingPage(req("/book/m/sometoken"))).toBe(false);
    expect(cacheableBookingPage(req("/book/vancouver/test-ride", "POST"))).toBe(false);
    expect(cacheableBookingPage(req("/b/token"))).toBe(false);
  });
});
