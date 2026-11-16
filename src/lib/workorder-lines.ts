/**
 * The parts and labour on a Lightspeed work order, read live (GET only) for the POS job screen.
 * Lightspeed keeps parts as WorkorderItems (an item from stock) and labour as WorkorderLines (a note, a time and a
 * price). Item names come from the Item records. Read defensively: a field Lightspeed leaves out shows as blank,
 * and if the whole read fails the screen says so instead of breaking.
 */
import type { Db } from "@/db/client";
import { asList, LightspeedClient } from "./lightspeed";
import { logger } from "./logger";

export type WorkorderLine = { id: string; kind: "part" | "labour"; description: string; qty: number; unitPrice: number | null; minutes: number | null; note: string };

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

/** Read a work order's lines from Lightspeed. Returns null when Lightspeed can't be reached. */
export async function fetchWorkorderLines(db: Db, workorderId: string, client = new LightspeedClient(db)): Promise<WorkorderLine[] | null> {
  try {
    const res = await client.request<Record<string, unknown>>("GET", `Workorder/${workorderId}.json?load_relations=${encodeURIComponent('["WorkorderItems","WorkorderLines"]')}`);
    const wo = (res.Workorder ?? {}) as Record<string, unknown>;
    const ids = new Set<string>();
    for (const w of asList<Record<string, unknown>>(wo.WorkorderItems as Record<string, unknown> | undefined, "WorkorderItem")) if (w.itemID && String(w.itemID) !== "0") ids.add(String(w.itemID));
    for (const l of asList<Record<string, unknown>>(wo.WorkorderLines as Record<string, unknown> | undefined, "WorkorderLine")) if (l.itemID && String(l.itemID) !== "0") ids.add(String(l.itemID));
    const names = new Map<string, { name: string; price: number | null }>();
    await Promise.all(
      [...ids].slice(0, 30).map(async (id) => {
        try {
          const r = await client.request<Record<string, unknown>>("GET", `Item/${id}.json?load_relations=${encodeURIComponent('["Prices"]')}`);
          const item = (r.Item ?? {}) as Record<string, unknown>;
          names.set(id, { name: String(item.description ?? "").trim(), price: itemPrice(item) });
        } catch {
          // A missing item still shows as a line, just without its name.
        }
      }),
    );
    return parseWorkorderLines(wo, names);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), workorderId }, "work order lines not read");
    return null;
  }
}
