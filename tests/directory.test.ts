import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { bookingTypes, showrooms } from "@/db/schema";
import { defaultTypes } from "@/lib/booking-types";
import { cityOf, loadDirectory, openLine, orderStores, visitorPosition } from "@/lib/directory";
import { resetDb, testDb } from "./helpers";

const STORES = [
  { slug: "vancouver", city: "Vancouver", lat: 49.26, lng: -123.04 },
  { slug: "calgary", city: "Calgary", lat: 50.95, lng: -114.07 },
  { slug: "edmonton", city: "Edmonton", lat: 53.54, lng: -113.49 },
  { slug: "nowhere", city: "Aardvark", lat: null, lng: null },
];
const HOURS = { "2": [["10:00", "17:15"]], "3": [["10:00", "17:15"]], "4": [["10:00", "17:15"]], "5": [["10:00", "17:15"]], "6": [["10:00", "17:15"]] } as Record<string, [string, string][]>;

describe("all-showrooms directory", () => {
  it("puts the closest store first and marks it only when it's near; A–Z without a position", () => {
    const red = orderStores(STORES, { lat: 51.29, lng: -114.01 }); // Airdrie
    expect(red.stores.map((s) => s.slug)).toEqual(["calgary", "edmonton", "vancouver", "nowhere"]);
    expect(red.closest).toBe("calgary");
    expect(orderStores(STORES, { lat: 43.65, lng: -79.38 }).closest).toBeNull(); // Toronto: sorted, no badge
    expect(orderStores(STORES, null)).toEqual({ stores: [STORES[3], STORES[1], STORES[2], STORES[0]], closest: null });
  });

  it("reads Vercel's position headers, and nothing locally", () => {
    const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
    expect(visitorPosition(h({ "x-vercel-ip-latitude": "51.04", "x-vercel-ip-longitude": "-114.06" }))).toEqual({ lat: 51.04, lng: -114.06 });
    expect(visitorPosition(h({}))).toBeNull();
  });

  it("says open now, opens later today, tomorrow or on a weekday, in the store's time", () => {
    const tz = "America/Edmonton";
    expect(openLine(HOURS, tz, new Date("2026-11-19T19:50:00Z"))).toEqual({ text: "Open now · until 5:15 pm", open: true }); // Thu 12:50
    expect(openLine(HOURS, tz, new Date("2026-11-19T15:00:00Z"))).toEqual({ text: "Opens 10 am", open: false }); // Thu 8:00
    expect(openLine(HOURS, tz, new Date("2026-11-20T01:00:00Z"))).toEqual({ text: "Opens tomorrow 10 am", open: false }); // Thu 18:00
    expect(openLine(HOURS, tz, new Date("2026-11-22T18:00:00Z"))).toEqual({ text: "Opens Tue 10 am", open: false }); // Sun
    expect(openLine({}, tz, new Date())).toBeNull();
    expect(cityOf("Biktrix Calgary")).toBe("Calgary");
  });

  describe("which stores are listed", () => {
    let db: Db;
    beforeAll(async () => { db = await testDb(); });
    afterAll(async () => { await db.$client.end(); });
    beforeEach(async () => { await resetDb(db); });

    it("only public, on, switched-in types with that slug, each with its store's hours", async () => {
      const [van] = await db.select().from(showrooms).limit(1);
      const [cal] = await db.insert(showrooms).values({ slug: "calgary", name: "Biktrix Calgary", timezone: "America/Edmonton", addressLine: "1 Macleod Trail SE, Calgary", bookingHours: HOURS }).returning();
      const [yyc2] = await db.insert(showrooms).values({ slug: "calgary-2", name: "Biktrix Calgary 2", timezone: "America/Edmonton", addressLine: "" }).returning();
      const visit = defaultTypes("showroom", HOURS).find((t) => t.slug === "showroom-visit")!;
      await db.insert(bookingTypes).values([
        { ...visit, showroomId: van.id, kind: "standard", inDirectory: true },
        { ...visit, showroomId: cal.id, kind: "standard", inDirectory: true },
        { ...visit, showroomId: yyc2.id, kind: "standard", inDirectory: false },
      ]);
      expect(await loadDirectory(db, "test-ride")).toBeNull();
      const dir = await loadDirectory(db, "showroom-visit");
      expect(dir?.stores.map((s) => s.slug).sort()).toEqual(["calgary", van.slug].sort());
      expect(dir?.stores.find((s) => s.slug === "calgary")).toMatchObject({ city: "Calgary", timezone: "America/Edmonton", hours: HOURS });

      await db.update(bookingTypes).set({ active: false }).where(eq(bookingTypes.showroomId, cal.id));
      expect((await loadDirectory(db, "showroom-visit"))?.stores.map((s) => s.slug)).toEqual([van.slug]);
    });
  });
});
