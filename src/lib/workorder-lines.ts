/**
 * The parts and labour on a Lightspeed work order, read live (GET only) for the POS job screen.
 * Lightspeed keeps parts as WorkorderItems (an item from stock) and labour as WorkorderLines (a note, a time and a
 * price). Item names come from the Item records. Read defensively: a field Lightspeed leaves out shows as blank,
 * and if the whole read fails the screen says so instead of breaking.
 */
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { lsItems, lsWorkorders } from "@/db/schema";
import { asList, LightspeedClient } from "./lightspeed";
import { logger } from "./logger";

/** itemId: the Lightspeed item behind the line (a service tile for labour), when there is one. */
export type WorkorderLine = { id: string; kind: "part" | "labour"; description: string; qty: number; unitPrice: number | null; minutes: number | null; note: string; itemId?: string | null };

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Pure: Lightspeed's Workorder JSON (with WorkorderItems and WorkorderLines) plus item names → lines. */
export function parseWorkorderLines(workorder: Record<string, unknown>, itemNames: Map<string, { name: string; price: number | null }>): WorkorderLine[] {
  const items = asList<Record<string, unknown>>(workorder.WorkorderItems as Record<string, unknown> | undefined, "WorkorderItem");
  const labour = asList<Record<string, unknown>>(workorder.WorkorderLines as Record<string, unknown> | undefined, "WorkorderLine");
  const parts: WorkorderLine[] = items.map((w) => {
    const item = itemNames.get(String(w.itemID ?? ""));
    const price = num(w.unitPrice);
    return {
      id: `i${w.workorderItemID ?? w.itemID}`,
      kind: "part",
      description: item?.name || String(w.note ?? "").trim() || `Item ${w.itemID ?? ""}`.trim(),
      qty: num(w.unitQuantity) ?? 1,
      unitPrice: price !== null && price > 0 ? price : (item?.price ?? price),
      minutes: null,
      note: item?.name ? String(w.note ?? "").trim() : "",
      itemId: w.itemID && String(w.itemID) !== "0" ? String(w.itemID) : null,
    };
  });
  const lines: WorkorderLine[] = labour.map((l) => {
    const hours = num(l.hours) ?? 0;
    const mins = num(l.minutes) ?? 0;
    const minutes = hours * 60 + mins;
    const item = l.itemID && String(l.itemID) !== "0" ? itemNames.get(String(l.itemID)) : undefined;
    const override = num(l.unitPriceOverride);
    return {
      id: `l${l.workorderLineID ?? Math.random()}`,
      kind: "labour",
      description: String(l.note ?? "").trim() || item?.name || "Labour",
      qty: num(l.unitQuantity) ?? 1,
      unitPrice: override !== null && override > 0 ? override : (item?.price ?? null),
      minutes: minutes > 0 ? minutes : null,
      note: "",
      itemId: l.itemID && String(l.itemID) !== "0" ? String(l.itemID) : null,
    };
  });
  return [...parts, ...lines];
}

export function linesSubtotal(lines: WorkorderLine[]): number | null {
  if (lines.some((l) => l.unitPrice === null)) return null;
  return lines.reduce((sum, l) => sum + (l.unitPrice ?? 0) * l.qty, 0);
}

function itemPrice(item: Record<string, unknown>): number | null {
  const prices = asList<Record<string, unknown>>(item.Prices as Record<string, unknown> | undefined, "ItemPrice");
  const p = prices.find((x) => String(x.useType) === "Default") ?? prices[0];
  return p ? num(p.amount) : null;
}

const ITEM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Item names and default prices: from Kickstand's memory when it has them (less than a week old), else from
 * Lightspeed, then remembered. So a job with eight parts costs one Lightspeed call after the first look.
 */
export async function itemNames(db: Db, ids: string[], client: LightspeedClient, now = new Date()): Promise<Map<string, { name: string; price: number | null }>> {
  const names = new Map<string, { name: string; price: number | null }>();
  if (ids.length === 0) return names;
  const cached = await db.select().from(lsItems).where(inArray(lsItems.id, ids));
  for (const c of cached) if (now.getTime() - c.fetchedAt.getTime() < ITEM_TTL_MS) names.set(c.id, { name: c.name, price: c.price });
  const missing = ids.filter((id) => !names.has(id)).slice(0, 30);
  await Promise.all(
    missing.map(async (id) => {
      try {
        // Plain GET: Prices come with the Item already, and Lightspeed refuses relations it doesn't allow.
        const r = await client.request<Record<string, unknown>>("GET", `Item/${id}.json`);
        const item = (r.Item ?? {}) as Record<string, unknown>;
        const entry = { name: String(item.description ?? "").trim(), price: itemPrice(item) };
        names.set(id, entry);
        await db.insert(lsItems).values({ id, ...entry, fetchedAt: now }).onConflictDoUpdate({ target: lsItems.id, set: { ...entry, fetchedAt: now } });
      } catch (err) {
        // A missing item still shows as a line, just without its name.
        logger.warn({ err: err instanceof Error ? err.message : String(err), itemId: id }, "lightspeed item not read");
      }
    }),
  );
  return names;
}

export type LinesResult = { status: "ok"; lines: WorkorderLine[] } | { status: "gone" } | { status: "failed"; reason: string };

/** Lightspeed's reason, short enough to show: "GET Workorder/123.json → 400: Tried to load … not allowed". */
export function lightspeedReason(err: unknown): string {
  const body = (err as { body?: { message?: unknown } }).body;
  const detail = body && typeof body.message === "string" ? `: ${body.message}` : "";
  return `${err instanceof Error ? err.message.replace(/\?.*? →/, " →") : String(err)}${detail}`.slice(0, 200);
}

/**
 * Read a work order's lines from Lightspeed. "gone" when Lightspeed says it no longer exists or it's archived
 * (deleted there); the caller takes it off the board. If Lightspeed refuses the parts/labour relations, the work
 * order is read plainly so a deleted one is still noticed, and the reason is passed on to show staff.
 */
export async function fetchWorkorderLines(db: Db, workorderId: string, client = new LightspeedClient(db)): Promise<LinesResult> {
  let res: Record<string, unknown>;
  try {
    res = await client.request<Record<string, unknown>>("GET", `Workorder/${workorderId}.json?load_relations=${encodeURIComponent('["WorkorderItems","WorkorderLines"]')}`);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return { status: "gone" };
    const reason = lightspeedReason(err);
    logger.warn({ err: reason, workorderId }, "work order lines not read");
    if (status === 400) {
      try {
        const plain = await client.request<Record<string, unknown>>("GET", `Workorder/${workorderId}.json`);
        if (String((plain.Workorder as Record<string, unknown> | undefined)?.archived) === "true") return { status: "gone" };
      } catch (e) {
        if ((e as { status?: number }).status === 404) return { status: "gone" };
      }
    }
    return { status: "failed", reason };
  }
  const wo = (res.Workorder ?? {}) as Record<string, unknown>;
  if (String(wo.archived) === "true") return { status: "gone" };
  const ids = new Set<string>();
  for (const w of asList<Record<string, unknown>>(wo.WorkorderItems as Record<string, unknown> | undefined, "WorkorderItem")) if (w.itemID && String(w.itemID) !== "0") ids.add(String(w.itemID));
  for (const l of asList<Record<string, unknown>>(wo.WorkorderLines as Record<string, unknown> | undefined, "WorkorderLine")) if (l.itemID && String(l.itemID) !== "0") ids.add(String(l.itemID));
  const names = await itemNames(db, [...ids], client);
  return { status: "ok", lines: parseWorkorderLines(wo, names) };
}

/** A work order deleted in Lightspeed: take it off Kickstand's board now instead of at the next sync. */
export async function forgetWorkorder(db: Db, workorderId: string): Promise<void> {
  await db.delete(lsWorkorders).where(eq(lsWorkorders.id, workorderId));
}
