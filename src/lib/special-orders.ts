/**
 * Special-order sync: every bike special-ordered in Lightspeed becomes a Kickstand order the same
 * hour, already linked to the Lightspeed customer — no CSV import, no duplicate customers later.
 *
 * Source of truth is Lightspeed's uncompleted special-order lines (SaleLine with isSpecialOrder and
 * saleID 0, see lightspeed.ts). Only lines whose item sits under the "Bikes" category become orders;
 * parts and accessories are counted and skipped (they get their own view later). Idempotent: the line
 * id is stored on the order (orders.ls_sale_line_id) and re-runs update rather than duplicate.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { appointments, orders, units, type Order } from "@/db/schema";
import { logEvent } from "./events";
import { getConnection, LightspeedClient, type SaleLineInfo } from "./lightspeed";
import { logger } from "./logger";
import type { ShowroomCtx } from "./showroom";
import { normalizeEmail, normalizePhone } from "./customers";
import { toLocalDate } from "./time";

export type SpecialOrderLine = {
  saleLineID: string;
  customerID: string;
  itemID: string;
  categoryPath: string;
  createTime: string;
  qty: number;
  bike: SaleLineInfo;
};

/** What the sync needs from Lightspeed — an interface so tests can feed lines without the API. */
export interface SpecialOrderSource {
  lines(shopID: number, since: string): Promise<SpecialOrderLine[]>;
  customer(customerID: string): Promise<{ name: string; email: string | null; phone: string | null }>;
}

export function isBikeCategory(fullPath: string): boolean {
  return /^bikes(\/|$)/i.test(fullPath.trim());
}

export class LightspeedSpecialOrderSource implements SpecialOrderSource {
  private client: LightspeedClient;
  private customers = new Map<string, Promise<{ name: string; email: string | null; phone: string | null }>>();
  constructor(dbx: Db) {
    this.client = new LightspeedClient(dbx);
  }
  async lines(shopID: number, since: string): Promise<SpecialOrderLine[]> {
    const [rows, categories] = await Promise.all([this.client.listOpenSpecialOrderLines(shopID, since), this.client.listCategories()]);
    const usable = rows.filter((l) => String(l.itemID ?? "0") !== "0" && String(l.customerID ?? "0") !== "0" && String(l.isWorkorder) !== "true");
    const category = (l: Record<string, unknown>) => categories.get(String((l.Item as Record<string, unknown> | undefined)?.categoryID ?? "")) ?? "";
    // Only bikes get the per-item attribute lookups (one Lightspeed call each); parts are counted and skipped.
    const bikes = usable.filter((l) => isBikeCategory(category(l)));
    const parts = usable.filter((l) => !isBikeCategory(category(l)));
    const described = await this.client.describeSaleLines(bikes);
    // describeSaleLines drops lines without a description; realign by index on the kept rows.
    const kept = bikes.filter((l) => String(((l.Item as Record<string, unknown> | undefined)?.description ?? l.description ?? "")).trim());
    const partLines: SpecialOrderLine[] = parts.map((l) => ({
      saleLineID: String(l.saleLineID), customerID: String(l.customerID), itemID: String(l.itemID), categoryPath: category(l),
      createTime: String(l.createTime ?? ""), qty: Number(l.unitQuantity ?? 1),
      bike: { description: String((l.Item as Record<string, unknown> | undefined)?.description ?? ""), qty: Number(l.unitQuantity ?? 1), model: "", size: null, colour: null },
    }));
    return partLines.concat(kept.map((l, i) => ({
      saleLineID: String(l.saleLineID),
      customerID: String(l.customerID),
      itemID: String(l.itemID),
      categoryPath: categories.get(String((l.Item as Record<string, unknown> | undefined)?.categoryID ?? "")) ?? "",
      createTime: String(l.createTime ?? ""),
      qty: Number(l.unitQuantity ?? 1),
      bike: described[i],
    })));
  }
  customer(customerID: string): Promise<{ name: string; email: string | null; phone: string | null }> {
    const cached = this.customers.get(customerID);
    if (cached) return cached;
    const p = this.client.getCustomer(customerID).then((c) => c ?? { name: "", email: null, phone: null });
    this.customers.set(customerID, p);
    return p;
  }
}

export type SyncSummary = { seen: number; bikes: number; created: number; adopted: number; updated: number; skippedParts: number; parts?: { created: number; updated: number; fulfilled: number }; errors: string[] };

export async function syncSpecialOrders(
  dbx: Db,
  args: { showroom: ShowroomCtx; actor: string; source?: SpecialOrderSource; now?: Date; sinceDays?: number },
): Promise<SyncSummary> {
  const { showroom } = args;
  const now = args.now ?? new Date();
  const shopID = showroom.settings.lightspeed.shop_id;
  if (!shopID) throw new Error(`${showroom.name} has no Lightspeed shop id — run showroom:add --shop or ls:setup --shop`);
  if (!args.source && !(await getConnection(dbx))) throw new Error("Lightspeed is not connected");
  const source = args.source ?? new LightspeedSpecialOrderSource(dbx);
  const since = new Date(now.getTime() - (args.sinceDays ?? 180) * 86_400_000).toISOString();
  const summary: SyncSummary = { seen: 0, bikes: 0, created: 0, adopted: 0, updated: 0, skippedParts: 0, errors: [] };

  const lines = await source.lines(shopID, since);
  summary.seen = lines.length;
  const bikeLines = lines.filter((l) => isBikeCategory(l.categoryPath));
  summary.skippedParts = lines.length - bikeLines.length;
  summary.bikes = bikeLines.length;
  // Parts & accessories get their own orders (Parts tab) and are fulfilled when Lightspeed completes them.
  try {
    summary.parts = await syncPartsOrders(dbx, { showroom, actor: args.actor, lines, customer: (id) => source.customer(id), now });
  } catch (err) {
    summary.errors.push(`parts: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (bikeLines.length === 0) return finish();

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
  const customerIds = [...new Set(bikeLines.map((l) => l.customerID))];
  const customers = new Map<string, { name: string; email: string | null; phone: string | null }>();
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
      const cust = customers.get(line.customerID) ?? { name: "", email: null, phone: null };
      const orderDate = line.createTime ? toLocalDate(new Date(line.createTime), showroom.timezone) : toLocalDate(now, showroom.timezone);
      const fields = {
        customerName: cust.name || `Lightspeed customer ${line.customerID}`,
        customerEmail: cust.email,
        customerPhone: cust.phone,
        model: line.bike.model,
        size: line.bike.size,
        colour: line.bike.colour,
        lsCustomerId: line.customerID,
      };
      let prev = byLine.get(line.saleLineID);
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
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push(`line ${line.saleLineID}: ${msg}`);
      logger.warn({ err: msg, saleLineID: line.saleLineID }, "special-order sync: line skipped");
    }
  }
  return finish();

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
 * Parts & accessories special orders: one Kickstand order per Lightspeed line (kind "parts"). When a
 * line is completed in Lightspeed it stops appearing in the open list; the matching Kickstand order is
 * then fulfilled and any booking closed, so it disappears from the Parts tab without staff doing anything.
 */
export async function syncPartsOrders(
  dbx: Db,
  args: { showroom: ShowroomCtx; actor: string; lines: SpecialOrderLine[]; customer: (id: string) => Promise<{ name: string; email: string | null; phone: string | null }>; now?: Date },
): Promise<{ created: number; updated: number; fulfilled: number }> {
  const { showroom } = args;
  const now = args.now ?? new Date();
  const partLines = args.lines.filter((l) => !isBikeCategory(l.categoryPath) && l.bike.description);
  const summary = { created: 0, updated: 0, fulfilled: 0 };
  const existing = await dbx.select().from(orders).where(and(eq(orders.showroomId, showroom.id), eq(orders.kind, "parts"), eq(orders.status, "open")));
  const byLine = new Map(existing.filter((o) => o.lsSaleLineId).map((o) => [o.lsSaleLineId!, o]));
  for (const line of partLines) {
    const prev = byLine.get(line.saleLineID);
    const cust = (await args.customer(line.customerID)) ?? { name: "", email: null, phone: null };
    const fields = {
      customerName: cust.name || `Lightspeed customer ${line.customerID}`,
      customerEmail: cust.email,
      customerPhone: cust.phone,
      model: line.qty > 1 ? `${line.bike.description} ×${line.qty}` : line.bike.description,
      lsCustomerId: line.customerID,
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
    } else {
      const changed = (Object.keys(fields) as (keyof typeof fields)[]).filter((k) => (prev[k] ?? null) !== (fields[k] ?? null));
      if (changed.length) {
        await dbx.update(orders).set(fields).where(eq(orders.id, prev.id));
        summary.updated++;
      }
    }
  }
  // Gone from Lightspeed's open list → completed there → done here.
  const openIds = new Set(partLines.map((l) => l.saleLineID));
  for (const o of existing) {
    if (!o.lsSaleLineId || openIds.has(o.lsSaleLineId)) continue;
    const us = await dbx.select().from(units).where(eq(units.orderId, o.id));
    for (const u of us) {
      await dbx.update(appointments).set({ status: "completed" }).where(and(eq(appointments.unitId, u.id), eq(appointments.status, "booked")));
      if (u.status !== "picked_up") await dbx.update(units).set({ status: "picked_up", pickedUpAt: now }).where(eq(units.id, u.id));
    }
    await dbx.update(orders).set({ status: "fulfilled" }).where(eq(orders.id, o.id));
    await logEvent(dbx, { showroomId: showroom.id, orderId: o.id, type: "fulfilled_in_lightspeed", actor: args.actor, payload: { sale_line_id: o.lsSaleLineId } });
    summary.fulfilled++;
  }
  return summary;
}
