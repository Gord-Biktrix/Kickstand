import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { LightspeedClient, saveConnection, setLightspeedFetch } from "@/lib/lightspeed";
import { isLabourName, loadServiceItems, minutesFromName, pickTiles, resetServiceItemCache, toServiceItems } from "@/lib/service-items";
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

  it("picks this store's workshop jobs from Gord's real list: no fees, rentals, prizes or other cities", () => {
    const names = [
      "1 hour eBike Rental Fee", "Half Day (3 hrs) E-Bike rental", "Custom Powder Coating", "Delivery Fee within City Limits",
      "Fairstone Admin Fee $500-$999.99", "Finance Admin fee 3%", "Motor Regrease", "No Limit - ( Off Road Use)", "Prize Wheel Spin 1 Spin",
      "Restocking Fee", "Service Package Back To The Basics", "Service Package Tune Up Calgary", "Service Package Tune Up Vancouver",
      "Service Package Tune Up Victoria", "Service Package In It For The Long Haul", "Service, Inspection and Tune Up", "Service Package Back To The Basics",
    ];
    const all = toServiceItems(names.map((d, i) => ({ itemID: String(i + 1), description: d })));
    const tiles = pickTiles(all, { selected: null, store: "Biktrix Vancouver vancouver", otherStores: ["Biktrix Calgary calgary", "Biktrix Victoria victoria"] });
    expect(tiles.map((t) => t.name).sort()).toEqual(["Back To The Basics", "In It For The Long Haul", "Motor Regrease", "Service, Inspection and Tune Up", "Tune Up"].sort());
    // A store's own pick wins, still tidied and still without other cities.
    const picked = pickTiles(all, { selected: [all.find((a) => a.name === "Service Package Tune Up Calgary")!.itemId, all.find((a) => a.name === "Custom Powder Coating")!.itemId], store: "Biktrix Vancouver vancouver", otherStores: ["Biktrix Calgary calgary"] });
    expect(picked.map((t) => t.name)).toEqual(["Custom Powder Coating"]);
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
