/**
 * Special-order sync: every bike special-ordered in Lightspeed becomes a Kickstand order the same
 * hour, already linked to the Lightspeed customer — no CSV import, no duplicate customers later.
 *
 * Source of truth is Lightspeed's uncompleted special-order lines (SaleLine with isSpecialOrder and
 * saleID 0, see lightspeed.ts). Only lines whose item sits under the "Bikes" category become orders;
 * parts and accessories get orders of their own (Parts tab). Idempotent: the line id is stored on the
 * order (orders.ls_sale_line_id) and re-runs update rather than duplicate.
 *
 * The other direction matters just as much: a line leaves Lightspeed's open list when the special order
 * is completed onto a sale (the customer paid and took it at the counter), when staff delete it, or when
 * it is pulled onto a sale that is still open at the register. Each open Kickstand order whose line has
 * left the list is looked up once and reconciled (sold → fulfilled, deleted → cancelled, unfinished sale →
 * left alone) so the On order and Parts lists never keep bikes Lightspeed has already let go of.
 */
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { appointments, events, orders, units, type Order } from "@/db/schema";
import { logEvent } from "./events";
import { getConnection, LightspeedClient, type SaleLineInfo } from "./lightspeed";
import { logger } from "./logger";
import type { ShowroomCtx } from "./showroom";
import { normalizeEmail, normalizePhone } from "./customers";
import { normalizePhone as toE164 } from "./phone";
import { toLocalDate } from "./time";

export type SpecialOrderLine = {
  saleLineID: string;
  customerID: string;
  itemID: string;
  categoryPath: string;
  createTime: string;
  qty: number;
  bike: SaleLineInfo;
  /** Free-text note on the Lightspeed sale line, if any. */
  note?: string | null;
  /** false = model/size/colour came from the description only (line already known; the item lookup was skipped). */
  described?: boolean;
};

/** What the source may skip for lines Kickstand has already imported. */
export type LineHints = { known?: Set<string> };

/**
 * Where a line that is no longer in the open list went. `open`: it still has saleID 0 (older than the
 * sync window, or filtered out) — nothing changed. `sold`: completed onto a sale that was paid out.
 * `deleted`: Lightspeed no longer has it. `in_sale`: on a sale still open at the register — not done yet.
 */
export type LineState = "open" | "deleted" | "sold" | "in_sale";

/** A special-order line rung up on a sale that has not been completed — invisible to the open list until it is. */
export type UnfinishedLine = { saleLineID: string; customerID: string; description: string; categoryPath: string; saleID: string };

function lineNote(l: Record<string, unknown>): string | null {
  const n = (l.Note as Record<string, unknown> | undefined)?.note;
  const text = typeof n === "string" ? n.trim() : "";
  return text || null;
}

type CustomerInfo = { name: string; email: string | null; phone: string | null };

/** What the sync needs from Lightspeed — an interface so tests can feed lines without the API. */
export interface SpecialOrderSource {
  lines(shopID: number, since: string, hints?: LineHints): Promise<SpecialOrderLine[]>;
  customer(customerID: string): Promise<CustomerInfo>;
  /** Asked once per open Kickstand order whose line is missing from `lines()`. */
  lineState(saleLineID: string): Promise<LineState>;
  /** Special-order lines on unfinished sales touched since `since` (ISO). Optional: the Sync button asks, the clock does not. */
  unfinished?(shopID: number, since: string): Promise<UnfinishedLine[]>;
}

export function isBikeCategory(fullPath: string): boolean {
  return /^bikes(\/|$)/i.test(fullPath.trim());
}

export class LightspeedSpecialOrderSource implements SpecialOrderSource {
  private client: LightspeedClient;
  private customers = new Map<string, Promise<CustomerInfo>>();
  private categories: Promise<Map<string, string>> | null = null;
  constructor(dbx: Db) {
    this.client = new LightspeedClient(dbx);
  }
  private categoryMap(): Promise<Map<string, string>> {
    this.categories ??= this.client.listCategories();
    return this.categories;
  }
  async lines(shopID: number, since: string, hints: LineHints = {}): Promise<SpecialOrderLine[]> {
    const [rows, categories] = await Promise.all([this.client.listOpenSpecialOrderLines(shopID, since), this.categoryMap()]);
    const usable = rows.filter((l) => String(l.itemID ?? "0") !== "0" && String(l.customerID ?? "0") !== "0" && String(l.isWorkorder) !== "true");
    const category = (l: Record<string, unknown>) => categories.get(String((l.Item as Record<string, unknown> | undefined)?.categoryID ?? "")) ?? "";
    // Only *new* bikes get the per-item attribute lookups (one Lightspeed call each); lines Kickstand already
    // holds keep their stored model/size/colour, so a store with 130 open orders syncs in seconds, not minutes.
    const known = hints.known ?? new Set<string>();
    const bikes = usable.filter((l) => isBikeCategory(category(l)));
    const parts = usable.filter((l) => !isBikeCategory(category(l)));
    const hasText = (l: Record<string, unknown>) => String(((l.Item as Record<string, unknown> | undefined)?.description ?? l.description ?? "")).trim();
    const fresh = bikes.filter((l) => hasText(l) && !known.has(String(l.saleLineID)));
    const freshInfo = await this.client.describeSaleLines(fresh);
    const freshByLine = new Map(fresh.map((l, i) => [String(l.saleLineID), freshInfo[i]]));
    const kept = bikes.filter((l) => hasText(l));
    const described = kept.map((l) => freshByLine.get(String(l.saleLineID)) ?? LightspeedClient.describeFromText(l));
    const partLines: SpecialOrderLine[] = parts.map((l) => ({
      saleLineID: String(l.saleLineID), customerID: String(l.customerID), itemID: String(l.itemID), categoryPath: category(l),
      createTime: String(l.createTime ?? ""), qty: Number(l.unitQuantity ?? 1), note: lineNote(l),
      bike: { description: String((l.Item as Record<string, unknown> | undefined)?.description ?? ""), qty: Number(l.unitQuantity ?? 1), model: "", size: null, colour: null },
    }));
    return partLines.concat(kept.map((l, i) => ({
      saleLineID: String(l.saleLineID),
      customerID: String(l.customerID),
      itemID: String(l.itemID),
      categoryPath: category(l),
      createTime: String(l.createTime ?? ""),
      qty: Number(l.unitQuantity ?? 1),
      note: lineNote(l),
      described: freshByLine.has(String(l.saleLineID)),
      bike: described[i],
    })));
  }
  customer(customerID: string): Promise<CustomerInfo> {
    const cached = this.customers.get(customerID);
    if (cached) return cached;
    const p = this.client.getCustomer(customerID).then((c) => c ?? { name: "", email: null, phone: null });
    this.customers.set(customerID, p);
    return p;
  }
  async lineState(saleLineID: string): Promise<LineState> {
    const l = await this.client.getSaleLine(saleLineID);
    if (!l) return "deleted";
    if (String(l.saleID ?? "0") === "0") return "open";
    return (await this.client.isSaleCompleted(String(l.saleID))) ? "sold" : "in_sale";
  }
  async unfinished(shopID: number, since: string): Promise<UnfinishedLine[]> {
    const [rows, categories] = await Promise.all([this.client.listSpecialOrderLinesInUnfinishedSales(shopID, since), this.categoryMap()]);
    return rows
      .filter((l) => String(l.itemID ?? "0") !== "0" && String(l.customerID ?? "0") !== "0" && String(l.isWorkorder) !== "true")
      .map((l) => {
        const item = l.Item as Record<string, unknown> | undefined;
        return {
          saleLineID: String(l.saleLineID), customerID: String(l.customerID), saleID: String(l.saleID),
          description: String(item?.description ?? l.description ?? "").trim(),
          categoryPath: categories.get(String(item?.categoryID ?? "")) ?? "",
        };
      });
  }
}

export type SyncSummary = {
  seen: number; bikes: number; created: number; adopted: number; updated: number; skippedParts: number;
  parts?: { created: number; updated: number; fulfilled: number };
  /** Open orders whose line left Lightspeed's open list, by what happened to it (bikes and parts). */
  reconciled: { fulfilled: number; cancelled: number; inSale: number; reopened: number };
  /** Orders staff must look at: the special order was deleted in Lightspeed but a box is already here. */
  attention: string[];
  /** "Customer · item" for special orders sitting in unfinished Lightspeed sales (only when `explain` is set). */
  unfinished?: string[];
  errors: string[];
};

export async function syncSpecialOrders(
  dbx: Db,
  args: { showroom: ShowroomCtx; actor: string; source?: SpecialOrderSource; now?: Date; sinceDays?: number; explain?: boolean },
): Promise<SyncSummary> {
  const { showroom } = args;
  const now = args.now ?? new Date();
  const shopID = showroom.settings.lightspeed.shop_id;
  if (!shopID) throw new Error(`${showroom.name} has no Lightspeed shop id — run showroom:add --shop or ls:setup --shop`);
  if (!args.source && !(await getConnection(dbx))) throw new Error("Lightspeed is not connected");
  const source = args.source ?? new LightspeedSpecialOrderSource(dbx);
  const since = new Date(now.getTime() - (args.sinceDays ?? 180) * 86_400_000).toISOString();
  const summary: SyncSummary = {
    seen: 0, bikes: 0, created: 0, adopted: 0, updated: 0, skippedParts: 0,
    reconciled: { fulfilled: 0, cancelled: 0, inSale: 0, reopened: 0 }, attention: [], errors: [],
  };

  // Lines already imported (bikes and parts) need no item or customer lookups — only their note/status matter.
  const knownRows = await dbx.select({ id: orders.lsSaleLineId }).from(orders).where(and(eq(orders.showroomId, showroom.id), isNotNull(orders.lsSaleLineId)));
  const known = new Set(knownRows.map((r) => r.id!));
  const lines = await source.lines(shopID, since, { known });
  summary.seen = lines.length;
  const bikeLines = lines.filter((l) => isBikeCategory(l.categoryPath));
  summary.skippedParts = lines.length - bikeLines.length;
  summary.bikes = bikeLines.length;
  // Parts & accessories get their own orders (Parts tab); they are closed by the reconciliation below like bikes.
  try {
    summary.parts = await syncPartsOrders(dbx, { showroom, actor: args.actor, lines, customer: (id) => source.customer(id), now, known, summary });
  } catch (err) {
    summary.errors.push(`parts: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (bikeLines.length > 0) await syncBikeLines();

  // Open orders whose line is no longer in the list: sold, deleted, or parked on an unfinished sale.
  await reconcileVanished(dbx, { showroom, actor: args.actor, source, seen: new Set(lines.map((l) => l.saleLineID)), now, summary });

  // On demand (the Sync button): what is rung up but not yet a special order, so staff know why a bike is missing.
  if (args.explain && source.unfinished) {
    try {
      const pending = await source.unfinished(shopID, new Date(now.getTime() - 7 * 86_400_000).toISOString());
      const labels: string[] = [];
      for (const l of pending) {
        const name = (await source.customer(l.customerID).catch(() => null))?.name || `Lightspeed customer ${l.customerID}`;
        labels.push(`${name} · ${l.description || l.saleLineID}`);
      }
      summary.unfinished = labels;
    } catch (err) {
      summary.errors.push(`unfinished sales: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return finish();

  async function syncBikeLines() {
    const existing = await dbx
      .select()
      .from(orders)
      .where(and(eq(orders.showroomId, showroom.id), inArray(orders.lsSaleLineId, bikeLines.map((l) => l.saleLineID))));
    const byLine = new Map(existing.map((o) => [o.lsSaleLineId!, o]));
    // Orders that came in another way (CSV import, Add an order, the register button) have no line id.
    // If one is open for the same person and the same model, adopt it rather than creating a twin.
    const unlinked = await dbx
      .select()
      .from(orders)
      .where(and(eq(orders.showroomId, showroom.id), eq(orders.status, "open"), eq(orders.kind, "bike"), isNull(orders.lsSaleLineId)));
    const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

    // Customer lookups dominate the run time (one Lightspeed call each); fetch them in parallel, a few at a time.
    // Every line's customer is re-read (a phone number fixed in Lightspeed must reach Kickstand); it's the
    // per-item attribute lookups that are skipped for known lines.
    const customerIds = [...new Set(bikeLines.map((l) => l.customerID))];
    const customers = new Map<string, CustomerInfo>();
    for (let i = 0; i < customerIds.length; i += 6) {
      await Promise.all(
        customerIds.slice(i, i + 6).map(async (id) => {
          try {
            customers.set(id, (await source.customer(id)) ?? { name: "", email: null, phone: null });
          } catch (err) {
            logger.warn({ err: err instanceof Error ? err.message : String(err), customerID: id }, "special-order sync: customer lookup failed");
          }
        }),
      );
    }

    for (const line of bikeLines) {
      try {
        let prev = byLine.get(line.saleLineID);
        const cust = customers.get(line.customerID) ?? (prev ? { name: prev.customerName, email: prev.customerEmail, phone: prev.customerPhone } : { name: "", email: null, phone: null });
        const orderDate = line.createTime ? toLocalDate(new Date(line.createTime), showroom.timezone) : toLocalDate(now, showroom.timezone);
        const fields = {
          customerName: cust.name || `Lightspeed customer ${line.customerID}`,
          customerEmail: cust.email,
          customerPhone: toE164(cust.phone) ?? cust.phone,
          // A known line skipped the item lookup: its stored model/size/colour are better than a text-only guess.
          ...(prev && line.described === false ? { model: prev.model, size: prev.size, colour: prev.colour } : { model: line.bike.model, size: line.bike.size, colour: line.bike.colour }),
          lsCustomerId: line.customerID,
          lsNote: line.note ?? null,
        };
        if (!prev) {
          const idx = unlinked.findIndex(
            (o) =>
              norm(o.model) === norm(fields.model) &&
              (o.lsCustomerId === line.customerID ||
                (!!normalizePhone(o.customerPhone) && normalizePhone(o.customerPhone) === normalizePhone(cust.phone)) ||
                (!!normalizeEmail(o.customerEmail) && normalizeEmail(o.customerEmail) === normalizeEmail(cust.email))),
          );
          if (idx >= 0) {
            const [adopted] = unlinked.splice(idx, 1);
            await dbx.update(orders).set({ lsSaleLineId: line.saleLineID, lsCustomerId: line.customerID }).where(eq(orders.id, adopted.id));
            await logEvent(dbx, { showroomId: showroom.id, orderId: adopted.id, type: "order_updated", actor: args.actor, payload: { source: "lightspeed_special_order", linked_sale_line_id: line.saleLineID, adopted: true } });
            prev = { ...adopted, lsSaleLineId: line.saleLineID, lsCustomerId: line.customerID };
            summary.adopted++;
          }
        }
        if (!prev) {
          const [created] = await dbx
            .insert(orders)
            .values({
              showroomId: showroom.id,
              orderRef: `SO${line.saleLineID}`,
              source: "lightspeed",
              orderDate,
              // The special-order line carries no payment info: flag it so the counter checks Lightspeed at handover.
              paymentStatus: "deposit",
              balanceCents: 0,
              termsVersion: 2,
              smsConsent: false,
              notes: "Synced from Lightspeed special order — confirm balance in Lightspeed at handover.",
              lsSaleLineId: line.saleLineID,
              ...fields,
            })
            .returning();
          await logEvent(dbx, { showroomId: showroom.id, orderId: created.id, type: "order_created", actor: args.actor, payload: { source: "lightspeed_special_order", sale_line_id: line.saleLineID, item_id: line.itemID, category: line.categoryPath } });
          summary.created++;
        } else if (prev.status === "open") {
          const changed = (Object.keys(fields) as (keyof typeof fields)[]).filter((k) => (prev[k] ?? null) !== (fields[k] ?? null));
          if (changed.length) {
            await dbx.update(orders).set(fields).where(eq(orders.id, prev.id));
            await logEvent(dbx, { showroomId: showroom.id, orderId: prev.id, type: "order_updated", actor: args.actor, payload: { source: "lightspeed_special_order", fields: changed } });
            summary.updated++;
          }
        } else if (await closedBySync(dbx, prev)) {
          await reopen(dbx, { showroom, actor: args.actor, order: prev, fields, summary });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summary.errors.push(`line ${line.saleLineID}: ${msg}`);
        logger.warn({ err: msg, saleLineID: line.saleLineID }, "special-order sync: line skipped");
      }
    }
  }

  async function finish() {
    await logEvent(dbx, { showroomId: showroom.id, type: "special_orders_synced", actor: args.actor, payload: { ...summary, since } });
    return summary;
  }
}

/** Orders on the books with no box received yet — "on order". Bikes by default; parts for the Parts tab. */
export async function ordersOnOrder(dbx: Db, showroom: ShowroomCtx, kind: "bike" | "parts" = "bike"): Promise<Order[]> {
  const rows = await dbx
    .select({ order: orders })
    .from(orders)
    .leftJoin(units, eq(units.orderId, orders.id))
    .where(and(eq(orders.showroomId, showroom.id), eq(orders.status, "open"), eq(orders.kind, kind), isNull(units.id)))
    .orderBy(orders.orderDate);
  return rows.map((r) => r.order);
}

/**
 * Parts & accessories special orders: one Kickstand order per Lightspeed line (kind "parts"). Closing
 * them when Lightspeed completes or deletes the line is `reconcileVanished`'s job, shared with bikes.
 */
export async function syncPartsOrders(
  dbx: Db,
  args: { showroom: ShowroomCtx; actor: string; lines: SpecialOrderLine[]; customer: (id: string) => Promise<CustomerInfo>; now?: Date; known?: Set<string>; summary?: SyncSummary },
): Promise<{ created: number; updated: number; fulfilled: number }> {
  const { showroom } = args;
  const now = args.now ?? new Date();
  const partLines = args.lines.filter((l) => !isBikeCategory(l.categoryPath) && l.bike.description);
  const summary = { created: 0, updated: 0, fulfilled: 0 };
  const existing = partLines.length
    ? await dbx.select().from(orders).where(and(eq(orders.showroomId, showroom.id), eq(orders.kind, "parts"), inArray(orders.lsSaleLineId, partLines.map((l) => l.saleLineID))))
    : [];
  const byLine = new Map(existing.map((o) => [o.lsSaleLineId!, o]));
  // Customer lookups in parallel, a few at a time (same as bikes) — sequential calls made a 90-line sync take half a minute.
  const customerIds = [...new Set(partLines.map((l) => l.customerID))];
  const customers = new Map<string, CustomerInfo>();
  for (let i = 0; i < customerIds.length; i += 6) {
    await Promise.all(customerIds.slice(i, i + 6).map(async (id) => {
      try { customers.set(id, (await args.customer(id)) ?? { name: "", email: null, phone: null }); } catch { /* left unknown; the order still gets created */ }
    }));
  }
  for (const line of partLines) {
    const prev = byLine.get(line.saleLineID);
    const cust = customers.get(line.customerID) ?? (prev ? { name: prev.customerName, email: prev.customerEmail, phone: prev.customerPhone } : { name: "", email: null, phone: null });
    const fields = {
      customerName: cust.name || `Lightspeed customer ${line.customerID}`,
      customerEmail: cust.email,
      customerPhone: toE164(cust.phone) ?? cust.phone,
      model: line.qty > 1 ? `${line.bike.description} ×${line.qty}` : line.bike.description,
      lsCustomerId: line.customerID,
      lsNote: line.note ?? null,
    };
    if (!prev) {
      await dbx.insert(orders).values({
        showroomId: showroom.id,
        orderRef: `SO${line.saleLineID}`,
        source: "lightspeed",
        kind: "parts",
        orderDate: line.createTime ? toLocalDate(new Date(line.createTime), showroom.timezone) : toLocalDate(now, showroom.timezone),
        paymentStatus: "deposit",
        balanceCents: 0,
        termsVersion: 2,
        smsConsent: false,
        notes: "Parts & accessories special order — confirm balance in Lightspeed at pickup.",
        lsSaleLineId: line.saleLineID,
        ...fields,
      });
      summary.created++;
    } else if (prev.status === "open") {
      const changed = (Object.keys(fields) as (keyof typeof fields)[]).filter((k) => (prev[k] ?? null) !== (fields[k] ?? null));
      if (changed.length) {
        await dbx.update(orders).set(fields).where(eq(orders.id, prev.id));
        summary.updated++;
      }
    } else if (args.summary && (await closedBySync(dbx, prev))) {
      // Back on Lightspeed's open list after the sync closed it (the sale was voided): open here again too.
      await reopen(dbx, { showroom, actor: args.actor, order: prev, fields, summary: args.summary });
    }
  }
  return summary;
}

const SYNC_CLOSE_EVENTS = ["fulfilled_in_lightspeed", "cancelled_in_lightspeed"];

/** True when the sync itself closed this order (not staff) and no box is attached — safe to reopen. */
async function closedBySync(dbx: Db, order: Order): Promise<boolean> {
  if (order.status !== "fulfilled" && order.status !== "cancelled") return false;
  const [closed] = await dbx.select({ id: events.id }).from(events).where(and(eq(events.orderId, order.id), inArray(events.type, SYNC_CLOSE_EVENTS))).limit(1);
  if (!closed) return false;
  const [unit] = await dbx.select({ id: units.id }).from(units).where(eq(units.orderId, order.id)).limit(1);
  return !unit;
}

async function reopen(dbx: Db, args: { showroom: ShowroomCtx; actor: string; order: Order; fields: Partial<typeof orders.$inferInsert>; summary: SyncSummary }) {
  await dbx.update(orders).set({ status: "open", deferredAt: null, ...args.fields }).where(eq(orders.id, args.order.id));
  await logEvent(dbx, { showroomId: args.showroom.id, orderId: args.order.id, type: "order_reopened", actor: args.actor, payload: { from: args.order.status, source: "lightspeed_special_order", sale_line_id: args.order.lsSaleLineId } });
  args.summary.reconciled.reopened++;
}

/**
 * Open orders whose Lightspeed line is no longer in the open list. One lookup each decides:
 * sold on a completed sale → fulfilled (booking completed, box picked up); deleted → cancelled, unless a
 * box is already here, in which case staff are told and decide; on an unfinished sale → wait; still open
 * (just older than the sync window) → nothing.
 */
export async function reconcileVanished(
  dbx: Db,
  args: { showroom: ShowroomCtx; actor: string; source: Pick<SpecialOrderSource, "lineState">; seen: Set<string>; now?: Date; summary: SyncSummary },
): Promise<void> {
  const { showroom, summary } = args;
  const now = args.now ?? new Date();
  const candidates = await dbx
    .select()
    .from(orders)
    .where(and(eq(orders.showroomId, showroom.id), inArray(orders.status, ["open", "deferred"]), isNotNull(orders.lsSaleLineId)));
  for (const o of candidates) {
    const lineId = o.lsSaleLineId!;
    if (args.seen.has(lineId)) continue;
    try {
      const state = await args.source.lineState(lineId);
      if (state === "open") continue;
      if (state === "in_sale") {
        summary.reconciled.inSale++;
        continue;
      }
      const us = await dbx.select().from(units).where(eq(units.orderId, o.id));
      if (state === "sold") {
        for (const u of us) {
          await dbx.update(appointments).set({ status: "completed" }).where(and(eq(appointments.unitId, u.id), eq(appointments.status, "booked")));
          if (u.status !== "picked_up") await dbx.update(units).set({ status: "picked_up", pickedUpAt: now }).where(eq(units.id, u.id));
        }
        await dbx.update(orders).set({ status: "fulfilled" }).where(eq(orders.id, o.id));
        await logEvent(dbx, { showroomId: showroom.id, orderId: o.id, type: "fulfilled_in_lightspeed", actor: args.actor, payload: { sale_line_id: lineId } });
        summary.reconciled.fulfilled++;
        if (o.kind === "parts" && summary.parts) summary.parts.fulfilled++;
        continue;
      }
      // Deleted in Lightspeed.
      if (us.length) {
        // The special order is gone but the bike is on the floor: not ours to decide. Flag it once.
        const [flagged] = await dbx.select({ id: events.id }).from(events).where(and(eq(events.orderId, o.id), eq(events.type, "lightspeed_line_deleted"))).limit(1);
        if (!flagged) await logEvent(dbx, { showroomId: showroom.id, orderId: o.id, type: "lightspeed_line_deleted", actor: args.actor, payload: { sale_line_id: lineId, boxes: us.map((u) => u.boxTag) } });
        summary.attention.push(`${o.orderRef} ${o.customerName} — special order deleted in Lightspeed but ${us.length === 1 ? `box ${us[0].boxTag} is` : `${us.length} boxes are`} already here`);
        continue;
      }
      await dbx.update(orders).set({ status: "cancelled", deferredAt: null }).where(eq(orders.id, o.id));
      await logEvent(dbx, { showroomId: showroom.id, orderId: o.id, type: "cancelled_in_lightspeed", actor: args.actor, payload: { sale_line_id: lineId, was: o.status } });
      summary.reconciled.cancelled++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push(`line ${lineId}: ${msg}`);
      logger.warn({ err: msg, saleLineID: lineId }, "special-order sync: reconciliation skipped");
    }
  }
}
