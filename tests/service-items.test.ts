import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { LightspeedClient, saveConnection, setLightspeedFetch } from "@/lib/lightspeed";
import { isLabourName, loadServiceItems, minutesFromName, resetServiceItemCache, toServiceItems } from "@/lib/service-items";
import { resetDb, testDb } from "./helpers";

describe("Lightspeed service and labour items for the tiles", () => {
  it("reads a time from the name", () => {
    expect(minutesFromName("1h30")).toBe(90);
    expect(minutesFromName("Labor 30 min")).toBe(30);
    expect(minutesFromName("15min")).toBe(15);
    expect(minutesFromName("2 hr")).toBe(120);
    expect(minutesFromName("1.5 hours")).toBe(90);
    expect(minutesFromName("Tune-up")).toBeNull();
  });

  it("names that are only a time are labour; the rest are services", () => {
    expect(isLabourName("15min")).toBe(true);
    expect(isLabourName("Labour 1h")).toBe(true);
    expect(isLabourName("1h30")).toBe(true);
    expect(isLabourName("Tune-up 1h")).toBe(false);
    expect(isLabourName("Flat fix")).toBe(false);
    const items = toServiceItems([
      { itemID: "1", description: "86-Tune Up", Prices: { ItemPrice: [{ amount: "89", useType: "Default" }] } },
      { itemID: "2", description: "30min" },
      { itemID: "3", description: "Old service", archived: "true" },
      { itemID: "4", description: "FlatOut" },
    ]);
    expect(items.map((i) => [i.name, i.price, i.minutes, i.labour])).toEqual([
      ["FlatOut", null, null, false],
      ["Tune Up", 89, null, false],
      ["30min", null, 30, true],
    ]);
  });

  describe("loading", () => {
    let db: Db;
    beforeAll(async () => { db = await testDb(); process.env.LS_CLIENT_ID ??= "x"; process.env.LS_CLIENT_SECRET ??= "y"; });
    afterAll(async () => { setLightspeedFetch(null); await db.$client.end(); });

    it("uses categories named Labour/Service/Repair, else non-inventory items, and keeps a copy for 30 minutes", async () => {
      await resetDb(db);
      await saveConnection(db, { accountId: "999", accessToken: "acc", refreshToken: "ref", expiresIn: 3600 });
      resetServiceItemCache();
      const urls: string[] = [];
      const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      setLightspeedFetch(async (input) => {
        const url = decodeURIComponent(String(input));
        urls.push(url);
        if (url.includes("Category.json")) return reply({ Category: [{ categoryID: "7", name: "Labour" }, { categoryID: "8", name: "Bikes" }, { categoryID: "9", name: "Service" }] });
        return reply({ Item: [{ itemID: "1", description: "Tune Up" }] });
      });
      const client = new LightspeedClient(db);
      expect((await loadServiceItems(client, 1000)).map((i) => i.name)).toEqual(["Tune Up"]);
      expect(urls.at(-1)).toContain("categoryID=IN,[7,9]");
      await loadServiceItems(client, 2000);
      expect(urls).toHaveLength(2); // cached
      resetServiceItemCache();
      setLightspeedFetch(async (input) => {
        const url = decodeURIComponent(String(input));
        urls.push(url);
        return url.includes("Category.json") ? reply({ Category: [{ categoryID: "8", name: "Bikes" }] }) : reply({ Item: [] });
      });
      await loadServiceItems(client, 3000);
      expect(urls.at(-1)).toContain("itemType=non_inventory");
    });
  });
});
