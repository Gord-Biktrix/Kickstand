/**
 * New ticket (a walk-in or phone-in repair) from the POS screen: find or add the customer, say what the bike is
 * and what it needs, and Kickstand creates the Lightspeed work order in Open, due when it should be ready. It lands
 * in To do on the Workshop board straight away (Kickstand's copy is written at once, not at the next sync).
 */
import { and, desc, ilike, inArray, isNotNull, like, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import { bookings, events, lsWorkorders, orders } from "@/db/schema";
import { asList, LightspeedClient, lightspeedEnabled } from "./lightspeed";
import { logger } from "./logger";
import { normalizePhone } from "./phone";
import type { ShowroomCtx } from "./showroom";

/** The service menu, until stores set their own (Settings › Services): name and usual time. */
export const SERVICE_MENU: { key: string; name: string; minutes: number }[] = [
  { key: "tune", name: "Tune-up", minutes: 60 },
  { key: "flat", name: "Flat fix", minutes: 20 },
  { key: "brakes", name: "Brake service", minutes: 45 },
  { key: "bleed", name: "Brake bleed", minutes: 30 },
  { key: "diag", name: "Look at it (diagnose)", minutes: 30 },
  { key: "motor", name: "Motor / battery check", minutes: 30 },
  { key: "wheel", name: "Wheel true", minutes: 20 },
  { key: "accessory", name: "Accessory install", minutes: 15 },
  { key: "warranty", name: "Warranty claim", minutes: 30 },
  { key: "other", name: "Something else", minutes: 30 },
];

export type CustomerMatch = { key: string; lsCustomerId: string | null; name: string; phone: string | null; email: string | null; source: string };

const digitsOf = (s: string) => s.replace(/\D/g, "");

/** Customers matching a name, phone (any 4+ digits) or email: Kickstand's own records first, then a Lightspeed name search. */
export async function searchCustomers(db: Db, query: string, client?: LightspeedClient): Promise<{ matches: CustomerMatch[]; lightspeedFailed: boolean }> {
  const q = query.trim();
  if (q.length < 2) return { matches: [], lightspeedFailed: false };
  const digits = digitsOf(q);
  const byPhone = digits.length >= 4;
  const out = new Map<string, CustomerMatch>();
  const add = (m: Omit<CustomerMatch, "key">) => {
    const key = m.lsCustomerId ? `ls:${m.lsCustomerId}` : `p:${normalizePhone(m.phone) ?? m.email ?? m.name}`;
    if (!out.has(key)) out.set(key, { key, ...m });
  };

  const orderRows = await db
    .select({ name: orders.customerName, phone: orders.customerPhone, email: orders.customerEmail, ls: orders.lsCustomerId })
    .from(orders)
    .where(byPhone ? like(orders.customerPhone, `%${digits}%`) : or(ilike(orders.customerName, `%${q}%`), ilike(orders.customerEmail, `%${q}%`)))
    .orderBy(desc(orders.updatedAt))
    .limit(8);
  for (const r of orderRows) add({ lsCustomerId: r.ls, name: r.name, phone: r.phone, email: r.email, source: "Kickstand order" });

  const bookingRows = await db
    .select({ name: bookings.customerName, phone: bookings.customerPhone, email: bookings.customerEmail, wo: bookings.lsWorkorderId })
    .from(bookings)
    .where(byPhone ? like(bookings.customerPhone, `%${digits}%`) : or(ilike(bookings.customerName, `%${q}%`), ilike(bookings.customerEmail, `%${q}%`)))
    .orderBy(desc(bookings.createdAt))
    .limit(8);
  const woCustomer = new Map<string, string>();
  const woIds = bookingRows.map((b) => b.wo).filter((x): x is string => !!x);
  if (woIds.length) {
    for (const w of await db.select({ id: lsWorkorders.id, c: lsWorkorders.customerId }).from(lsWorkorders).where(inArray(lsWorkorders.id, woIds))) if (w.c) woCustomer.set(w.id, w.c);
  }
  for (const r of bookingRows) add({ lsCustomerId: r.wo ? (woCustomer.get(r.wo) ?? null) : null, name: r.name, phone: r.phone, email: r.email, source: "Kickstand booking" });

  if (!byPhone) {
    const woRows = await db
      .select({ name: lsWorkorders.customerName, c: lsWorkorders.customerId })
      .from(lsWorkorders)
      .where(and(isNotNull(lsWorkorders.customerId), ilike(lsWorkorders.customerName, `%${q}%`)))
      .limit(8);
    for (const r of woRows) add({ lsCustomerId: r.c, name: r.name, phone: null, email: null, source: "Lightspeed work order" });
  }

  // Lightspeed's own customer list, by name (its API can't search phone numbers).
  let lightspeedFailed = false;
  if (!byPhone && client) {
    try {
      const like = encodeURIComponent(`%${q.replace(/[%|,]/g, " ")}%`);
      const res = await client.request<Record<string, unknown>>(
        "GET",
        `Customer.json?limit=10&archived=false&load_relations=${encodeURIComponent('["Contact"]')}&or=${encodeURIComponent("firstName=~,")}${like}${encodeURIComponent("|lastName=~,")}${like}`,
      );
      for (const c of asList<Record<string, unknown>>(res, "Customer")) {
        const contact = c.Contact as Record<string, unknown> | undefined;
        const phones = asList<{ number: string; useType?: string }>(contact?.Phones as Record<string, unknown>, "ContactPhone");
        const emails = asList<{ address: string }>(contact?.Emails as Record<string, unknown>, "ContactEmail");
        add({ lsCustomerId: String(c.customerID), name: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim(), phone: (phones.find((p) => p.useType === "Mobile") ?? phones[0])?.number ?? null, email: emails[0]?.address ?? null, source: "Lightspeed" });
      }
    } catch (err) {
      lightspeedFailed = true;
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "lightspeed customer search failed");
    }
  }
  return { matches: [...out.values()].slice(0, 10), lightspeedFailed };
}

export type NewTicket = {
  customer: { lsCustomerId: string; name: string } | { name: string; phone: string; email: string };
  bike: string;
  serial: string;
  service: string;
  said: string;
  readyBy: Date;
  employeeId: string | null;
};

export class TicketError extends Error {}

export function checkTicket(t: NewTicket): void {
  const name = t.customer.name.trim();
  if (!name) throw new TicketError("Pick the customer, or add their name and mobile.");
  if (!("lsCustomerId" in t.customer) && !normalizePhone(t.customer.phone) && !t.customer.email.trim()) throw new TicketError("Add a mobile number (or an email) so we can tell them when it's ready.");
  if (!t.bike.trim()) throw new TicketError("Say which bike it is.");
  if (!t.service) throw new TicketError("Tap what it needs.");
}

/** Create the work order in Lightspeed (Open, date in now, due at ready-by) and put it on the board. */
export async function createTicket(db: Db, args: { showroom: ShowroomCtx; ticket: NewTicket; actor: string; now?: Date; client?: LightspeedClient }): Promise<string> {
  const { showroom, ticket } = args;
  if (!lightspeedEnabled(showroom)) throw new TicketError("Lightspeed isn't switched on for this store, so tickets can't be created here yet.");
  checkTicket(ticket);
  const now = args.now ?? new Date();
  const client = args.client ?? new LightspeedClient(db);
  const ls = showroom.settings.lightspeed;
  let customerId: string;
  let customerName = ticket.customer.name.trim();
  if ("lsCustomerId" in ticket.customer) {
    customerId = ticket.customer.lsCustomerId;
  } else {
    const phone = normalizePhone(ticket.customer.phone);
    customerId = await client.createCustomer({ customerName, customerEmail: ticket.customer.email.trim() || null, customerPhone: phone });
    customerName = customerName.replace(/\s+/g, " ");
  }
  const note = [
    `${ticket.service.toUpperCase()} · ticket from Kickstand`,
    `Bike: ${ticket.bike.trim()}${ticket.serial.trim() ? ` · serial ${ticket.serial.trim()}` : ""}`,
    ticket.said.trim() ? `Customer says: ${ticket.said.trim()}` : "",
  ].filter(Boolean).join("\n");
  let workorderID: string;
  try {
    workorderID = await client.createWorkorder({
      shopID: ls.shop_id,
      customerID: Number(customerId),
      ...(ticket.employeeId ? { employeeID: Number(ticket.employeeId) } : ls.employee_id ? { employeeID: ls.employee_id } : {}),
      timeIn: now.toISOString(),
      etaOut: ticket.readyBy.toISOString(),
      warranty: ticket.service === "Warranty claim",
      workorderStatusID: ls.open_status_id,
      hookIn: ticket.service.slice(0, 40),
      note,
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ticket not created in Lightspeed");
    throw new TicketError("Lightspeed didn't create the work order. Nothing was saved; try again in a minute.");
  }
  await db.insert(lsWorkorders).values({
    id: workorderID,
    showroomId: showroom.id,
    statusId: ls.open_status_id,
    customerId,
    customerName,
    item: ticket.bike.trim(),
    serial: ticket.serial.trim() || null,
    note,
    employeeId: ticket.employeeId,
    timeIn: now,
    etaOut: ticket.readyBy,
    lsUpdatedAt: now,
  }).onConflictDoNothing();
  await db.insert(events).values({ showroomId: showroom.id, type: "ticket_created", actor: args.actor, payload: { workorder_id: workorderID, customer_id: customerId, service: ticket.service } });
  return workorderID;
}
