/**
 * Customer view over orders. Kickstand has no customer table (SPEC models orders and units), so a
 * "customer" is the set of orders that share a Lightspeed customer ID, a phone number or an email.
 * The key in URLs (/app/customers/<key>) names the strongest identifier we have for the group.
 */
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { appointments, bookings, bookingTypes, events, orders, units, type Appointment, type Booking, type BookingType, type Event, type Order, type Unit } from "@/db/schema";
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

/**
 * Everyone who collects with this customer: their own orders (same person) plus any orders staff linked
 * with "Pick up together" (orders.pickup_group). One level: a linked partner's other orders only join
 * when they are linked too.
 */
export async function pickupCircleOrders(dbx: Db, showroom: ShowroomCtx, order: Order): Promise<Order[]> {
  const theirs = await customerOrders(dbx, showroom, customerKey(order));
  const own = theirs.some((o) => o.id === order.id) ? theirs : [order, ...theirs];
  const groups = [...new Set(own.map((o) => o.pickupGroup).filter((g): g is string => !!g))];
  if (groups.length === 0) return own;
  const linked = await dbx.select().from(orders).where(and(eq(orders.showroomId, showroom.id), inArray(orders.pickupGroup, groups)));
  return [...own, ...linked.filter((l) => own.every((o) => o.id !== l.id))];
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
export type CustomerVisit = { booking: Booking; type: BookingType };

/** The customer key for someone known only from a booking (test ride, call…): phone, then email, then name. */
export function bookingCustomerKey(b: Pick<Booking, "customerPhone" | "customerEmail" | "customerName">): CustomerKey {
  const ph = normalizePhone(b.customerPhone);
  if (ph) return `ph:${ph}`;
  const em = normalizeEmail(b.customerEmail);
  if (em) return `em:${em}`;
  return `nm:${b.customerName.trim().toLowerCase()}`;
}

/** Bookings in this store made with any of these phones (compared on the last 10 digits) or emails, newest first. */
export async function visitsFor(dbx: Db, showroomId: string, phones: string[], emails: string[]): Promise<CustomerVisit[]> {
  const conds = [
    ...phones.map((p) => sql`right(regexp_replace(coalesce(${bookings.customerPhone}, ''), '\\D', '', 'g'), 10) = ${p.slice(-10)}`),
    emails.length ? sql`lower(${bookings.customerEmail}) in ${emails}` : undefined,
  ].filter((c): c is NonNullable<typeof c> => !!c);
  if (!conds.length) return [];
  return dbx
    .select({ booking: bookings, type: bookingTypes })
    .from(bookings)
    .innerJoin(bookingTypes, eq(bookingTypes.id, bookings.bookingTypeId))
    .where(and(eq(bookings.showroomId, showroomId), or(...conds)))
    .orderBy(desc(bookings.startsAt))
    .limit(100);
}
export type CustomerProfile = {
  key: CustomerKey;
  name: string;
  phone: string | null;
  email: string | null;
  lsCustomerId: string | null;
  orders: Order[];
  bikes: CustomerBike[];
  events: Event[];
  /** Bookings of booking types (test rides, service, calls) matched by phone or email. */
  visits: CustomerVisit[];
};

export async function customerProfile(dbx: Db, showroom: ShowroomCtx, key: string): Promise<CustomerProfile | null> {
  const list = await customerOrders(dbx, showroom, key);
  if (list.length === 0) {
    // Someone who has only booked (a test ride, a call): no orders, so the profile comes from their bookings.
    const parsed = parseCustomerKey(key);
    if (!parsed || (parsed.kind !== "ph" && parsed.kind !== "em")) return null;
    const visits = await visitsFor(dbx, showroom.id, parsed.kind === "ph" ? [parsed.value] : [], parsed.kind === "em" ? [parsed.value] : []);
    if (visits.length === 0) return null;
    const latest = visits[0].booking;
    return {
      key: parsed.kind === "ph" ? `ph:${parsed.value}` : `em:${parsed.value}`,
      name: latest.customerName,
      phone: visits.map((v) => v.booking.customerPhone).find(Boolean) ?? null,
      email: visits.map((v) => v.booking.customerEmail).find(Boolean) ?? null,
      lsCustomerId: null,
      orders: [],
      bikes: [],
      events: [],
      visits,
    };
  }
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
    visits: await visitsFor(
      dbx,
      showroom.id,
      [...new Set(list.map((o) => normalizePhone(o.customerPhone)).filter((v): v is string => !!v))],
      [...new Set(list.map((o) => normalizeEmail(o.customerEmail)).filter((v): v is string => !!v))],
    ),
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
  /** How many bookings (test rides, service, calls) this person has in the store. */
  visits: number;
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
  const hits: CustomerHit[] = grouped
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
        visits: 0,
        lastActivity: last,
      };
    });
  // People who booked a test ride, service or call: added to their order-based customer when phone or email
  // match, otherwise listed on their own (a lead who hasn't bought yet).
  const bookingRows = await dbx
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.showroomId, showroom.id),
        or(
          sql`${bookings.customerName} ilike ${term}`,
          sql`${bookings.customerEmail} ilike ${term}`,
          digits.length >= 4 ? sql`regexp_replace(coalesce(${bookings.customerPhone}, ''), '\\D', '', 'g') like ${`%${digits}%`}` : sql`false`,
        ),
      ),
    )
    .orderBy(desc(bookings.updatedAt))
    .limit(200);
  for (const b of bookingRows) {
    const ph = normalizePhone(b.customerPhone);
    const em = normalizeEmail(b.customerEmail);
    const hit = hits.find((h) => (ph && normalizePhone(h.phone) === ph) || (em && normalizeEmail(h.email) === em) || h.key === bookingCustomerKey(b));
    if (hit) {
      hit.visits++;
      if (b.updatedAt > hit.lastActivity) hit.lastActivity = b.updatedAt;
    } else {
      hits.push({ key: bookingCustomerKey(b), name: b.customerName, phone: b.customerPhone, email: b.customerEmail, lsCustomerId: null, orders: [], units: [], visits: 1, lastActivity: b.updatedAt });
    }
  }
  return hits.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime()).slice(0, limit);
}
