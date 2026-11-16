/**
 * The New ticket service and labour tiles, from the shop's own Lightspeed items: items in categories named like
 * Labour / Service / Repair / Tune, or (if there are none) the non-inventory items, which is how shops usually set
 * up labour. Names that are just a length of time ("15min", "Labor 30 min", "1h30") go on the Labour tab; the rest
 * are services. Lightspeed doesn't know how long a service takes, so the time comes from the name when it has one.
 * Read only; kept for 30 minutes so a page load doesn't cost Lightspeed calls.
 */
import { asList, type LightspeedClient } from "./lightspeed";

export type ServiceItem = { itemId: string; name: string; price: number | null; minutes: number | null; labour: boolean };

/** "1h30" → 90, "Labor 30 min" → 30, "45 mins" → 45, "2 hr" → 120, "Tune-up" → null. */
export function minutesFromName(name: string): number | null {
  const n = name.toLowerCase();
  const hm = /(\d+(?:\.\d+)?)\s*(?:hours|hour|hrs|hr|h)(?![a-z])\s*(\d{1,2})?\s*(?:mins|min|m)?(?![a-z])/.exec(n);
  if (hm) return Math.round(Number(hm[1]) * 60 + (hm[2] ? Number(hm[2]) : 0));
  const m = /(\d{1,3})\s*(?:minutes|mins|min|m)(?![a-z])/.exec(n);
  return m ? Number(m[1]) : null;
}

/** A tile whose name is only a length of time (with maybe "labour"/"labor"/"shop time") is a labour tile. */
export function isLabourName(name: string): boolean {
  if (minutesFromName(name) === null) return false;
  const rest = name.toLowerCase().replace(/(\d+(?:\.\d+)?)\s*(hours|hour|hrs|hr|h|minutes|mins|min|m)(?![a-z])/g, "").replace(/\d+/g, "");
  return /^[\s\-·:+]*(labou?r|shop\s*time|time)?[\s\-·:+]*$/.test(rest);
}

function price(i: Record<string, unknown>): number | null {
  const prices = asList<Record<string, unknown>>(i.Prices as Record<string, unknown> | undefined, "ItemPrice");
  const p = (prices.find((x) => String(x.useType) === "Default") ?? prices[0])?.amount;
  return p === undefined || p === null || String(p) === "" ? null : Number(p);
}

export function toServiceItems(items: Record<string, unknown>[]): ServiceItem[] {
  return items
    .filter((i) => String(i.archived) !== "true" && String(i.serialized) !== "true")
    .map((i) => {
      const name = String(i.description ?? "").replace(/^\d+\s*-\s*/, "").trim();
      return { itemId: String(i.itemID), name, price: price(i), minutes: minutesFromName(name), labour: isLabourName(name) };
    })
    .filter((s) => s.name)
    .sort((a, b) => Number(a.labour) - Number(b.labour) || (a.minutes ?? 999) - (b.minutes ?? 999) || a.name.localeCompare(b.name));
}

const CATEGORY = /labou?r|service|repair|tune/i;
let cache: { at: number; items: ServiceItem[] } | null = null;

export async function loadServiceItems(client: LightspeedClient, now = Date.now()): Promise<ServiceItem[]> {
  if (cache && now - cache.at < 30 * 60 * 1000) return cache.items;
  const cats = asList<Record<string, unknown>>(await client.request<Record<string, unknown>>("GET", "Category.json?limit=100"), "Category")
    .filter((c) => CATEGORY.test(String(c.name ?? "")))
    .map((c) => String(c.categoryID));
  const query = cats.length ? `categoryID=${encodeURIComponent(`IN,[${cats.join(",")}]`)}` : "itemType=non_inventory";
  const res = await client.request<Record<string, unknown>>("GET", `Item.json?limit=100&archived=false&${query}`);
  const items = toServiceItems(asList<Record<string, unknown>>(res, "Item")).slice(0, 60);
  cache = { at: now, items };
  return items;
}

/** Tests: forget the 30-minute copy. */
export function resetServiceItemCache() {
  cache = null;
}
