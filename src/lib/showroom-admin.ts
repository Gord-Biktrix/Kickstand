import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { capacityRules, showrooms } from "@/db/schema";
import { DEFAULT_SETTINGS, type ProgramSettings } from "./settings";
import { listShowrooms, patchShowroomSettings, type ShowroomCtx } from "./showroom";

/**
 * Stores (showrooms) from the UI — Settings › Stores. Each store has its own Lightspeed link: a shop id
 * (work orders and special orders live per shop, so two stores never see each other's), its own
 * work-order status mapping and employee. Lightspeed work-order *statuses* are account-wide and may be
 * shared between stores; the shop is what keeps stores apart, and a shop can belong to only one store.
 */
export type NewShowroom = { slug: string; name: string; timezone: string; addressLine: string; phone: string | null; copyCapacityFrom?: string | null };

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/biktrix/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "store";
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function createShowroom(dbx: Db, input: NewShowroom): Promise<ShowroomCtx> {
  const slug = slugify(input.slug || input.name);
  if (!input.name.trim()) throw new Error("Give the store a name.");
  if (!validTimezone(input.timezone)) throw new Error(`"${input.timezone}" is not a valid time zone (use an IANA name such as America/Regina).`);
  const [taken] = await dbx.select({ id: showrooms.id }).from(showrooms).where(eq(showrooms.slug, slug));
  if (taken) throw new Error(`A store with the id "${slug}" already exists.`);
  const settings: ProgramSettings = { ...DEFAULT_SETTINGS, lightspeed: { ...DEFAULT_SETTINGS.lightspeed, enabled: false } };
  const [row] = await dbx
    .insert(showrooms)
    .values({ slug, name: input.name.trim(), timezone: input.timezone, addressLine: input.addressLine.trim(), phone: input.phone?.trim() || null, settings })
    .returning();
  // Capacity: start from another store's weekly template so the calendar isn't empty; adjust in Settings › Capacity.
  if (input.copyCapacityFrom) {
    const [src] = await dbx.select().from(showrooms).where(eq(showrooms.slug, input.copyCapacityFrom));
    if (src) {
      const rules = await dbx.select().from(capacityRules).where(eq(capacityRules.showroomId, src.id));
      for (const r of rules) {
        await dbx.insert(capacityRules).values({ showroomId: row.id, weekday: r.weekday, capacity: r.capacity, windowStart: r.windowStart, windowEnd: r.windowEnd, maxConcurrent: r.maxConcurrent }).onConflictDoNothing();
      }
      // Program settings (lead times, cutoffs, flags) copy too; the Lightspeed link stays off until configured.
      const srcSettings = (await listShowrooms(dbx)).find((s) => s.id === src.id)?.settings;
      if (srcSettings) await patchShowroomSettings(dbx, row.id, { ...srcSettings, lightspeed: settings.lightspeed });
    }
  }
  return (await listShowrooms(dbx)).find((s) => s.id === row.id)!;
}

export async function updateShowroomDetails(dbx: Db, id: string, patch: { name: string; timezone: string; addressLine: string; phone: string | null }): Promise<void> {
  if (!patch.name.trim()) throw new Error("Give the store a name.");
  if (!validTimezone(patch.timezone)) throw new Error(`"${patch.timezone}" is not a valid time zone.`);
  await dbx.update(showrooms).set({ name: patch.name.trim(), timezone: patch.timezone, addressLine: patch.addressLine.trim(), phone: patch.phone?.trim() || null }).where(eq(showrooms.id, id));
}

export type LightspeedLink = {
  enabled: boolean;
  shop_id: number | null;
  employee_id: number | null;
  open_status_id: number;
  booked_status_id: number | null;
  completed_status_id: number | null;
};

/**
 * Save a store's Lightspeed link. One Lightspeed shop per store (that is what keeps work orders and
 * special orders apart). Statuses may be shared between stores — a work order only ever belongs to
 * one shop, so "Pickup: Booked" can be the booked status for every store.
 */
export async function setLightspeedLink(dbx: Db, showroomId: string, link: LightspeedLink): Promise<void> {
  const others = (await listShowrooms(dbx)).filter((s) => s.id !== showroomId);
  if (link.enabled && !link.shop_id) throw new Error("Pick the Lightspeed shop before switching the link on.");
  if (link.shop_id) {
    const clash = others.find((s) => s.settings.lightspeed.shop_id === link.shop_id);
    if (clash) throw new Error(`Lightspeed shop ${link.shop_id} is already linked to ${clash.name}. One shop per store.`);
  }
  for (const [label, id] of [["booked", link.booked_status_id], ["completed", link.completed_status_id]] as const) {
    if (id && id === link.open_status_id) throw new Error(`The ${label} status can't be the same as the "new work order" status.`);
  }
  if (link.booked_status_id && link.completed_status_id && link.booked_status_id === link.completed_status_id) throw new Error("Booked and completed must be different statuses.");
  const statuses: Record<string, number> = {};
  if (link.booked_status_id) statuses.booked = link.booked_status_id;
  if (link.completed_status_id) statuses.completed = link.completed_status_id;
  const [current] = await dbx.select().from(showrooms).where(eq(showrooms.id, showroomId));
  const prev = ((current?.settings as { lightspeed?: Partial<ProgramSettings["lightspeed"]> } | undefined)?.lightspeed) ?? {};
  await patchShowroomSettings(dbx, showroomId, {
    lightspeed: {
      ...DEFAULT_SETTINGS.lightspeed,
      ...prev,
      enabled: link.enabled,
      shop_id: link.shop_id,
      employee_id: link.employee_id,
      open_status_id: link.open_status_id,
      statuses,
    },
  });
}

/** Lightspeed stores its shops in US zone names; Kickstand shows Canadian ones (same clocks). */
const TZ_ALIASES: Record<string, string> = {
  "America/Los_Angeles": "America/Vancouver",
  "America/Denver": "America/Edmonton",
  "America/Chicago": "America/Winnipeg",
  "America/New_York": "America/Toronto",
  "US/Pacific": "America/Vancouver",
  "US/Mountain": "America/Edmonton",
  "US/Central": "America/Winnipeg",
  "US/Eastern": "America/Toronto",
};

export type LightspeedShopInfo = { shopID: string; name: string; timeZone: string | null; addressLine: string; phone: string | null };

/** "Biktrix Kelowna Showroom" → name "Biktrix Kelowna", slug "kelowna", tz America/Vancouver. Pure, for tests. */
export function shopToStore(shop: LightspeedShopInfo): NewShowroom & { shopId: number } {
  const name = shop.name.replace(/\s*showroom\s*$/i, "").trim() || shop.name;
  const tz = shop.timeZone ? (TZ_ALIASES[shop.timeZone] ?? shop.timeZone) : "America/Vancouver";
  return { slug: slugify(name), name, timezone: validTimezone(tz) ? tz : "America/Vancouver", addressLine: shop.addressLine, phone: shop.phone, shopId: Number(shop.shopID) };
}

/**
 * Create a Kickstand store for every Lightspeed shop that isn't linked yet. Each new store gets the shop's
 * name, time zone, address and phone, hours/settings copied from `copyFrom`, and its Lightspeed link
 * pre-filled with the shop but switched OFF — statuses are per store and still need choosing.
 */
export async function importShowroomsFromLightspeed(dbx: Db, shops: LightspeedShopInfo[], copyFrom: string | null): Promise<{ created: string[]; skipped: string[] }> {
  const existing = await listShowrooms(dbx);
  const created: string[] = [];
  const skipped: string[] = [];
  for (const shop of shops) {
    const proto = shopToStore(shop);
    const linked = existing.find((s) => s.settings.lightspeed.shop_id === proto.shopId);
    const sameSlug = existing.find((s) => s.slug === proto.slug);
    if (linked || sameSlug) {
      skipped.push(`${proto.name} (${linked ? `already ${linked.name}` : "id taken"})`);
      continue;
    }
    const store = await createShowroom(dbx, { ...proto, copyCapacityFrom: copyFrom });
    await setLightspeedLink(dbx, store.id, { enabled: false, shop_id: proto.shopId, employee_id: null, open_status_id: 1, booked_status_id: null, completed_status_id: null });
    existing.push((await listShowrooms(dbx)).find((s) => s.id === store.id)!);
    created.push(proto.name);
  }
  return { created, skipped };
}
