/**
 * New ticket (a walk-in or phone-in repair) from the POS screen: find or add the customer, say what the bike is
 * and what it needs, and Kickstand creates the Lightspeed work order in Open, due when it should be ready. It lands
 * in To do on the Workshop board straight away (Kickstand's copy is written at once, not at the next sync).
 */
import { and, desc, eq, ilike, inArray, isNotNull, like, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { bookings, events, lsWorkorders, orders, ticketPhotos, units } from "@/db/schema";
import { asList, LightspeedClient, lightspeedEnabled } from "./lightspeed";
import { logger } from "./logger";
import { normalizePhone } from "./phone";
import { baseUrl } from "./messages";
import { itemNames, lightspeedReason } from "./workorder-lines";
import { createTypeBooking } from "./type-bookings";
import type { BookingType } from "@/db/schema";
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

  // Lightspeed's own customer list, by name (its API can't search phone numbers). Only when Kickstand's own
  // records come up short and at least 3 letters are typed, to spare Lightspeed's request allowance.
  let lightspeedFailed = false;
  if (!byPhone && client && q.length >= 3 && out.size < 3) {
    try {
      // "Alan Uyeno" → first name like Alan AND last name like Uyeno; one word → first OR last name like it.
      const words = q.replace(/[%|,~]/g, " ").split(/\s+/).filter(Boolean);
      const pct = (w: string) => encodeURIComponent(`%${w}%`);
      const filter =
        words.length >= 2
          ? `firstName=${encodeURIComponent("~,")}${pct(words[0])}&lastName=${encodeURIComponent("~,")}${pct(words.slice(1).join(" "))}`
          : `or=${encodeURIComponent("firstName=~,")}${pct(words[0])}${encodeURIComponent("|lastName=~,")}${pct(words[0])}`;
      const res = await client.request<Record<string, unknown>>("GET", `Customer.json?limit=10&archived=false&load_relations=${encodeURIComponent('["Contact"]')}&${filter}`);
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

/** "86-Kutty X 2 Yellow" → "Kutty X 2 Yellow": drops the numeric code some Lightspeed item names start with. */
export function bikeName(raw: string): string {
  return raw.replace(/^\d+\s*-\s*/, "").trim();
}

export type CustomerBike = { key: string; label: string; serial: string | null; serializedId: string | null; source: string };

/**
 * The bikes a customer has, for the New ticket bike buttons: bikes they picked up through Kickstand, bikes on
 * their past work orders, and bikes registered to them in Lightspeed (Serialized items, which carry the serial).
 */
export async function customerBikes(db: Db, who: { lsCustomerId: string | null; phone: string | null; email: string | null }, client?: LightspeedClient): Promise<CustomerBike[]> {
  return (await customerBikesWithStatus(db, who, client)).bikes;
}

/** As customerBikes, plus what went wrong asking Lightspeed (shown on screen so staff can report it). */
export async function customerBikesWithStatus(db: Db, who: { lsCustomerId: string | null; phone: string | null; email: string | null }, client?: LightspeedClient): Promise<{ bikes: CustomerBike[]; lightspeedError: string | null }> {
  let lightspeedError: string | null = null;
  const out = new Map<string, CustomerBike>();
  // The same bike can come from Lightspeed and from a pickup with a size added, so match on model + colour.
  const add = (b: Omit<CustomerBike, "key">, sameAs?: string) => {
    const label = b.label.replace(/\s+/g, " ").trim();
    if (!label) return;
    const key = (sameAs ?? label).replace(/\s+/g, " ").trim().toLowerCase();
    const prev = out.get(key);
    if (!prev) out.set(key, { key, ...b, label });
    else if (!prev.serial && b.serial) out.set(key, { ...prev, serial: b.serial, serializedId: b.serializedId ?? prev.serializedId });
  };

  // Lightspeed first: its records carry the serial and can be attached to the work order.
  if (who.lsCustomerId && client) {
    try {
      // The bike's name usually lives on the linked Item ("86-Juggernaut Classic Duo Step-Thru 17\" Champagne 24x4");
      // the serialized record's own description, size and colour are often blank. Lightspeed won't load the Item
      // relation on Serialized, so names come from the item lookup (remembered in ls_items).
      const res = await client.request<Record<string, unknown>>("GET", `Serialized.json?customerID=${encodeURIComponent(who.lsCustomerId)}&limit=20`);
      const rows = asList<Record<string, unknown>>(res, "Serialized").filter((r) => String(r.archived) !== "true");
      const itemIds = [...new Set(rows.map((r) => String(r.itemID ?? "")).filter((id) => id && id !== "0"))];
      const items = await itemNames(db, itemIds, client);
      for (const r of rows) {
        const name = bikeName(String(r.description ?? "").trim() || items.get(String(r.itemID ?? ""))?.name || "");
        const serial = r.serial ? String(r.serial).trim() : "";
        const label = [name, r.colorName, r.sizeName].filter((x) => x && String(x).trim()).map(String).join(" · ") || (serial ? `Bike · serial ${serial}` : "");
        add(
          { label, serial: serial || null, serializedId: r.serializedID ? String(r.serializedID) : null, source: "Lightspeed" },
          [name, r.colorName].filter((x) => x && String(x).trim()).map(String).join(" · ") || label,
        );
      }
    } catch (err) {
      const body = (err as { body?: { message?: unknown } }).body;
      const detail = body && typeof body.message === "string" ? `: ${body.message}` : "";
      lightspeedError = `${err instanceof Error ? err.message.replace(/\?.*? →/, " →") : String(err)}${detail}`.slice(0, 200);
      logger.warn({ err: lightspeedError }, "lightspeed bikes not read");
    }
  }

  const phone = normalizePhone(who.phone);
  const conds = [
    who.lsCustomerId ? eq(orders.lsCustomerId, who.lsCustomerId) : undefined,
    phone ? eq(orders.customerPhone, phone) : undefined,
    who.email ? sql`lower(${orders.customerEmail}) = ${who.email.toLowerCase()}` : undefined,
  ].filter(Boolean);
  if (conds.length) {
    const rows = await db
      .select({ model: units.model, colour: units.colour, size: units.size })
      .from(units)
      .innerJoin(orders, eq(orders.id, units.orderId))
      .where(and(or(...conds), ne(units.kind, "parts")))
      .orderBy(desc(units.receivedAt))
      .limit(10);
    for (const r of rows) add({ label: [r.model, r.colour, r.size].filter(Boolean).join(" · "), serial: null, serializedId: null, source: "Bought here" }, [r.model, r.colour].filter(Boolean).join(" · "));
  }

  if (who.lsCustomerId) {
    const rows = await db.select({ item: lsWorkorders.item, serial: lsWorkorders.serial }).from(lsWorkorders).where(eq(lsWorkorders.customerId, who.lsCustomerId)).limit(10);
    for (const r of rows) add({ label: r.item, serial: r.serial, serializedId: null, source: "Past work order" });
  }
  return { bikes: [...out.values()].slice(0, 6), lightspeedError };
}

export type PartMatch = { itemId: string; name: string; price: number | null };

/** "Juggernaut Classic Duo Step-Thru 17\" Champagne 24x4" → "Juggernaut Classic": the model words parts are named after. */
export function bikeModel(bike: string): string {
  return bike.replace(/^\d+\s*-\s*/, "").split(/[·,]/)[0].trim().split(/\s+/).slice(0, 2).join(" ");
}

/**
 * Parts for the Parts tab: Lightspeed items matching what's typed, or (with nothing typed) the chosen bike's model
 * ("Kutty", "Juggernaut Classic"). Serialized items (the bikes themselves) are left out. Read only.
 */
export async function searchParts(client: LightspeedClient, args: { q: string; bike: string }): Promise<PartMatch[]> {
  const term = (args.q.trim() || bikeModel(args.bike)).replace(/[%|,~]/g, " ").trim();
  if (term.length < 2) return [];
  // One pattern with the words in order: "Juggernaut Classic" → %Juggernaut%Classic% (finds "Juggernaut Classic brake pads").
  const words = term.split(/\s+/).filter(Boolean).slice(0, 3);
  const res = await client.request<Record<string, unknown>>("GET", `Item.json?limit=40&archived=false&description=${encodeURIComponent("~,")}${encodeURIComponent(`%${words.join("%")}%`)}`);
  return asList<Record<string, unknown>>(res, "Item")
    .filter((i) => String(i.serialized) !== "true")
    .map((i) => {
      const prices = asList<Record<string, unknown>>(i.Prices as Record<string, unknown> | undefined, "ItemPrice");
      const price = (prices.find((p) => String(p.useType) === "Default") ?? prices[0])?.amount;
      return { itemId: String(i.itemID), name: bikeName(String(i.description ?? "").trim()), price: price !== undefined && price !== null && String(price) !== "" ? Number(price) : null };
    })
    .filter((p) => p.name)
    .slice(0, 24);
}

export type NewTicket = {
  customer: { lsCustomerId: string; name: string } | { name: string; phone: string; email: string };
  bike: string;
  serial: string;
  service: string;
  said: string;
  readyBy: Date;
  employeeId: string | null;
  /** A Lightspeed Serialized (the customer's registered bike) to attach to the work order. */
  serializedId?: string | null;
  /** Parts picked from the Parts tab: added to the work order as Lightspeed lines (and listed in the note). */
  parts?: { itemId: string; name: string; qty: number }[];
  /** Photos (base64 JPEG) taken at the counter; kept in Kickstand and shown on the job screen. */
  photos?: string[];
};

const MAX_PHOTOS = 6;
const MAX_PHOTO_CHARS = 900_000; // ~650 KB of JPEG; the device sends ~150–300 KB.

/** The photo data URLs a New ticket sends (data:image/jpeg;base64,…): the base64 parts that are valid, up to 6. */
export function ticketPhotoData(dataUrls: string[]): string[] {
  return dataUrls
    .map((u) => /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(u.trim())?.[1] ?? "")
    .filter((b) => b && b.length <= MAX_PHOTO_CHARS)
    .slice(0, MAX_PHOTOS);
}

export async function saveTicketPhotos(db: Db, args: { showroomId: string; workorderId: string; images: string[]; actor: string }): Promise<number> {
  if (!args.images.length) return 0;
  await db.insert(ticketPhotos).values(args.images.map((image) => ({ showroomId: args.showroomId, workorderId: args.workorderId, image, createdBy: args.actor })));
  return args.images.length;
}

export async function listTicketPhotos(db: Db, workorderId: string): Promise<{ id: string; createdAt: Date }[]> {
  return db.select({ id: ticketPhotos.id, createdAt: ticketPhotos.createdAt }).from(ticketPhotos).where(eq(ticketPhotos.workorderId, workorderId)).orderBy(ticketPhotos.createdAt);
}

/** Services and parts become real lines on the work order (Lightspeed reserves stock). One that fails is reported. */
export async function addWorkorderParts(client: LightspeedClient, workorderID: string, parts: { itemId: string; name: string; qty: number }[], employeeId: string | null): Promise<{ added: number; failed: string[] }> {
  let added = 0;
  const failed: string[] = [];
  for (const p of parts) {
    try {
      await client.request("POST", "WorkorderItem.json", {
        workorderID: Number(workorderID),
        itemID: Number(p.itemId),
        unitQuantity: p.qty,
        warranty: false,
        isSpecialOrder: false,
        ...(employeeId ? { employeeID: Number(employeeId) } : {}),
      });
      added++;
    } catch (err) {
      failed.push(p.name);
      logger.warn({ err: lightspeedReason(err), workorderID, itemId: p.itemId }, "part not added to the work order");
    }
  }
  return { added, failed };
}

/** Photos stay in Kickstand; the work order's internal note points staff in Lightspeed to them. */
async function attachTicketPhotos(db: Db, client: LightspeedClient, args: { showroomId: string; workorderId: string; images: string[]; actor: string }): Promise<number> {
  const photos = await saveTicketPhotos(db, args);
  if (photos) {
    try {
      await client.updateWorkorder(args.workorderId, { internalNote: `${photos} photo${photos > 1 ? "s" : ""} in Kickstand: ${baseUrl()}/app/workshop/w-${args.workorderId}` });
    } catch (err) {
      logger.warn({ err: lightspeedReason(err), workorderID: args.workorderId }, "photo note not added to the work order");
    }
  }
  return photos;
}

/**
 * A ticket for later: book the store's service type at the drop-off time (the customer gets the usual
 * confirmation; the work order goes in as Appointment, for the Lightspeed customer and bike already picked), then
 * put the ticket's services and parts on that work order as lines and keep its photos.
 */
export async function scheduleTicket(
  db: Db,
  args: {
    showroom: ShowroomCtx; type: BookingType; startsAt: Date; smsConsent: boolean; actor: string; client?: LightspeedClient;
    customer: { lsCustomerId: string | null; name: string; phone: string; email: string };
    bike: string; serial: string; serializedId: string | null; service: string; said: string; employeeId: string | null;
    parts: { itemId: string; name: string; qty: number }[]; photos: string[];
  },
): Promise<{ bookingId: string; workorderId: string | null; partsAdded: number; partsFailed: string[] }> {
  if (!args.service.trim()) throw new TicketError("Tap what it needs.");
  const { booking } = await createTypeBooking(db, {
    showroom: args.showroom,
    type: args.type,
    startsAt: args.startsAt,
    createdBy: args.actor,
    details: { name: args.customer.name, email: args.customer.email, phone: args.customer.phone, smsConsent: args.smsConsent, note: [args.service, args.said.trim()].filter(Boolean).join(". ") },
    answers: (field) => (field === "q_bike" ? args.bike : field === "q_serial" ? args.serial : ""),
    lsCustomerId: args.customer.lsCustomerId,
    lsSerializedId: args.serializedId,
  });
  if (!booking.lsWorkorderId) return { bookingId: booking.id, workorderId: null, partsAdded: 0, partsFailed: args.parts.map((p) => p.name) };
  const client = args.client ?? new LightspeedClient(db);
  const { added, failed } = await addWorkorderParts(client, booking.lsWorkorderId, args.parts, args.employeeId);
  await attachTicketPhotos(db, client, { showroomId: args.showroom.id, workorderId: booking.lsWorkorderId, images: args.photos, actor: args.actor });
  return { bookingId: booking.id, workorderId: booking.lsWorkorderId, partsAdded: added, partsFailed: failed };
}

export type TicketResult = { workorderId: string; partsAdded: number; partsFailed: string[] };

export class TicketError extends Error {}

export function checkTicket(t: NewTicket): void {
  const name = t.customer.name.trim();
  if (!name) throw new TicketError("Pick the customer, or add their name and mobile.");
  if (!("lsCustomerId" in t.customer) && !normalizePhone(t.customer.phone) && !t.customer.email.trim()) throw new TicketError("Add a mobile number (or an email) so we can tell them when it's ready.");
  if (!t.bike.trim()) throw new TicketError("Say which bike it is.");
  if (!t.service) throw new TicketError("Tap what it needs.");
}

/** Create the work order in Lightspeed (Open, date in now, due at ready-by) and put it on the board. */
export async function createTicket(db: Db, args: { showroom: ShowroomCtx; ticket: NewTicket; actor: string; now?: Date; client?: LightspeedClient }): Promise<TicketResult> {
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
    ticket.said.trim() ? `Notes: ${ticket.said.trim()}` : "",
    ticket.parts?.length ? `Items: ${ticket.parts.map((p) => `${p.name}${p.qty > 1 ? ` ×${p.qty}` : ""}`).join(", ")}` : "",
  ].filter(Boolean).join("\n");
  let workorderID: string;
  try {
    workorderID = await client.createWorkorder({
      shopID: ls.shop_id,
      customerID: Number(customerId),
      ...(ticket.employeeId ? { employeeID: Number(ticket.employeeId) } : ls.employee_id ? { employeeID: ls.employee_id } : {}),
      timeIn: now.toISOString(),
      etaOut: ticket.readyBy.toISOString(),
      warranty: ticket.service.includes("Warranty claim"),
      workorderStatusID: ls.open_status_id,
      hookIn: ticket.service.slice(0, 40),
      note,
      ...(ticket.serializedId ? { serializedID: Number(ticket.serializedId) } : {}),
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
  const { added: partsAdded, failed: partsFailed } = await addWorkorderParts(client, workorderID, ticket.parts ?? [], ticket.employeeId);
  const photos = await attachTicketPhotos(db, client, { showroomId: showroom.id, workorderId: workorderID, images: ticket.photos ?? [], actor: args.actor });
  await db.insert(events).values({ showroomId: showroom.id, type: "ticket_created", actor: args.actor, payload: { workorder_id: workorderID, customer_id: customerId, service: ticket.service, parts_added: partsAdded, parts_failed: partsFailed, photos } });
  return { workorderId: workorderID, partsAdded, partsFailed };
}
