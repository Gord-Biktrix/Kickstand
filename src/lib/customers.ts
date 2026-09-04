/**
 * Customer view over orders. Kickstand has no customer table (SPEC models orders and units), so a
 * "customer" is the set of orders that share a Lightspeed customer ID, a phone number or an email.
 * The key in URLs (/app/customers/<key>) names the strongest identifier we have for the group.
 */
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { appointments, events, orders, units, type Appointment, type Event, type Order, type Unit } from "@/db/schema";
import type { ShowroomCtx } from "./showroom";

export type CustomerKey = `ls:${string}` | `ph:${string}` | `em:${string}` | `nm:${string}`;

/** Digits only, without a leading North American country code; null when too short to be a number. */
export function normalizePhone(p: string | null | undefined): string | null {
  if (!p) return null;
  let d = p.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length >= 7 ? d : null;
}

export function normalizeEmail(e: string | null | undefined): string | null {
  const v = (e ?? "").trim().toLowerCase();
  return v.includes("@") ? v : null;
}

type Ident = Pick<Order, "lsCustomerId" | "customerPhone" | "customerEmail" | "customerName">;

/** Strongest identifier first: Lightspeed customer → phone → email → name. */
export function customerKey(o: Ident): CustomerKey {
  if (o.lsCustomerId) return `ls:${o.lsCustomerId}`;
  const ph = normalizePhone(o.customerPhone);
  if (ph) return `ph:${ph}`;
  const em = normalizeEmail(o.customerEmail);
  if (em) return `em:${em}`;
  return `nm:${o.customerName.trim().toLowerCase()}`;
}

export function parseCustomerKey(key: string): { kind: "ls" | "ph" | "em" | "nm"; value: string } | null {
  const m = /^(ls|ph|em|nm):(.+)$/.exec(key);
  return m ? { kind: m[1] as "ls" | "ph" | "em" | "nm", value: m[2] } : null;
}

/** Do two orders belong to the same person? Any shared strong identifier counts. */
export function sameCustomer(a: Ident, b: Ident): boolean {
  if (a.lsCustomerId && b.lsCustomerId) return a.lsCustomerId === b.lsCustomerId;
  const pa = normalizePhone(a.customerPhone), pb = normalizePhone(b.customerPhone);
  if (pa && pb && pa === pb) return true;
  const ea = normalizeEmail(a.customerEmail), eb = normalizeEmail(b.customerEmail);
  if (ea && eb && ea === eb) return true;
  if (a.lsCustomerId && a.lsCustomerId === b.lsCustomerId) return true;
  return !pa && !pb && !ea && !eb && a.customerName.trim().toLowerCase() === b.customerName.trim().toLowerCase();
}

/** Group orders into customers (union by any shared identifier). Groups keep the order they were first seen. */
export function groupOrders<T extends Ident>(rows: T[]): T[][] {
  const groups: T[][] = [];
  for (const row of rows) {
    const hits = groups.filter((g) => g.some((o) => sameCustomer(o, row)));
    if (hits.length === 0) groups.push([row]);
    else {
      hits[0].push(row);
      // A row can bridge two previously separate groups (e.g. ls id in one, same phone in another).
      for (const extra of hits.slice(1)) {
        hits[0].push(...extra);
        groups.splice(groups.indexOf(extra), 1);
      }
    }
  }
  return groups;
}

/** SQL: the order's phone, digits only, contains these digits (formatting-insensitive). */
function phoneDigits(digits: string) {
  return sql`regexp_replace(coalesce(${orders.customerPhone}, ''), '\\D', '', 'g') like ${`%${digits.slice(-10)}%`}`;
}

/** All orders for the customer named by `key`, expanded once through shared phone/email/ls id. */
export async function customerOrders(dbx: Db, showroom: ShowroomCtx, key: string): Promise<Order[]> {
  const parsed = parseCustomerKey(key);
  if (!parsed) return [];
  const base = and(eq(orders.showroomId, showroom.id));
  const seedWhere =
    parsed.kind === "ls" ? eq(orders.lsCustomerId, parsed.value)
    : parsed.kind === "ph" ? phoneDigits(parsed.value)
    : parsed.kind === "em" ? sql`lower(${orders.customerEmail}) = ${parsed.value}`
    : sql`lower(${orders.customerName}) = ${parsed.value}`;
  const seedRows = await dbx.select().from(orders).where(and(base, seedWhere));
  const seed = seedRows.filter((o) => {
    if (parsed.kind === "ph") return normalizePhone(o.customerPhone) === parsed.value;
    if (parsed.kind === "nm") return !o.lsCustomerId && !normalizePhone(o.customerPhone) && !normalizeEmail(o.customerEmail);
    return true;
  });
  if (seed.length === 0) return [];
  const lsIds = [...new Set(seed.map((o) => o.lsCustomerId).filter((v): v is string => !!v))];
  const phones = [...new Set(seed.map((o) => normalizePhone(o.customerPhone)).filter((v): v is string => !!v))];
  const emails = [...new Set(seed.map((o) => normalizeEmail(o.customerEmail)).filter((v): v is string => !!v))];
  const conds = [
    lsIds.length ? inArray(orders.lsCustomerId, lsIds) : undefined,
    ...phones.map((p) => phoneDigits(p)),
    emails.length ? sql`lower(${orders.customerEmail}) in ${emails}` : undefined,
  ].filter((c): c is NonNullable<typeof c> => !!c);
  const rows = conds.length ? await dbx.select().from(orders).where(and(base, or(...conds))) : seed;
  const all = [...seed, ...rows.filter((r) => seed.every((s) => s.id !== r.id) && seed.some((s) => sameCustomer(s, r)))];
  return all.sort((a, b) => (a.orderDate < b.orderDate ? 1 : a.orderDate > b.orderDate ? -1 : 0));
}

export type CustomerBike = { unit: Unit; order: Order; appointment: Appointment | null };
export type CustomerProfile = {
  key: CustomerKey;
  name: string;
  phone: string | null;
  email: string | null;
  lsCustomerId: string | null;
  orders: Order[];
  bikes: CustomerBike[];
  events: Event[];
};

export async function customerProfile(dbx: Db, showroom: ShowroomCtx, key: string): Promise<CustomerProfile | null> {
  const list = await customerOrders(dbx, showroom, key);
  if (list.length === 0) return null;
  const ids = list.map((o) => o.id);
  const [unitRows, evs] = await Promise.all([
    dbx.select().from(units).where(inArray(units.orderId, ids)).orderBy(desc(units.createdAt)),
    dbx.select().from(events).where(inArray(events.orderId, ids)).orderBy(desc(events.createdAt)).limit(150),
  ]);
  const appts = unitRows.length
    ? await dbx.select().from(appointments).where(inArray(appointments.unitId, unitRows.map((u) => u.id))).orderBy(desc(appointments.createdAt))
    : [];
  const latest = new Map<string, Appointment>();
  for (const a of appts) if (!latest.has(a.unitId)) latest.set(a.unitId, a);
  const byId = new Map(list.map((o) => [o.id, o]));
  const primary = list.find((o) => o.lsCustomerId) ?? list[0];
  return {
    key: customerKey(primary),
    name: primary.customerName,
    phone: list.map((o) => o.customerPhone).find(Boolean) ?? null,
    email: list.map((o) => o.customerEmail).find(Boolean) ?? null,
    lsCustomerId: primary.lsCustomerId ?? null,
    orders: list,
    bikes: unitRows.map((unit) => ({ unit, order: byId.get(unit.orderId!)!, appointment: latest.get(unit.id) ?? null })).filter((b) => b.order),
    events: evs,
  };
}

export type CustomerHit = {
  key: CustomerKey;
  name: string;
  phone: string | null;
  email: string | null;
  lsCustomerId: string | null;
  orders: Order[];
  units: Unit[];
  lastActivity: Date;
};

/** Search every order (any status) by name, sale number, phone, email or model, grouped into customers. */
export async function searchCustomers(dbx: Db, showroom: ShowroomCtx, q: string, limit = 40): Promise<CustomerHit[]> {
  const needle = q.trim();
  if (!needle) return [];
  const term = `%${needle}%`;
  const digits = needle.replace(/\D/g, "");
  const rows = await dbx
    .select({ order: orders, unit: units })
    .from(orders)
    .leftJoin(units, eq(units.orderId, orders.id))
    .where(
      and(
        eq(orders.showroomId, showroom.id),
        or(
          sql`${orders.customerName} ilike ${term}`,
          sql`${orders.orderRef} ilike ${term}`,
          sql`${orders.customerEmail} ilike ${term}`,
          sql`${orders.model} ilike ${term}`,
          sql`${units.boxTag} ilike ${term}`,
          digits.length >= 4 ? sql`regexp_replace(coalesce(${orders.customerPhone}, ''), '\\D', '', 'g') like ${`%${digits}%`}` : sql`false`,
        ),
      ),
    )
    .orderBy(desc(orders.updatedAt))
    .limit(400);
  const orderMap = new Map<string, { order: Order; units: Unit[] }>();
  for (const r of rows) {
    const entry = orderMap.get(r.order.id) ?? { order: r.order, units: [] };
    if (r.unit) entry.units.push(r.unit);
    orderMap.set(r.order.id, entry);
  }
  const grouped = groupOrders([...orderMap.values()].map((e) => e.order));
  return grouped
    .map((group) => {
      const primary = group.find((o) => o.lsCustomerId) ?? group[0];
      const us = group.flatMap((o) => orderMap.get(o.id)?.units ?? []);
      const last = [...group.map((o) => o.updatedAt), ...us.map((u) => u.updatedAt)].sort((a, b) => b.getTime() - a.getTime())[0];
      return {
        key: customerKey(primary),
        name: primary.customerName,
        phone: group.map((o) => o.customerPhone).find(Boolean) ?? null,
        email: group.map((o) => o.customerEmail).find(Boolean) ?? null,
        lsCustomerId: primary.lsCustomerId ?? null,
        orders: group,
        units: us,
        lastActivity: last,
      };
    })
    .sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime())
    .slice(0, limit);
}
