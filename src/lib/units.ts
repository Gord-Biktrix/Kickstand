import { and, asc, eq, inArray, notExists, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { appointments, events, orders, units, type NewOrder, type Order, type StaffUser, type Unit } from "@/db/schema";
import { hasRole } from "./roles";
import { cancelBookingTx, decrementCounter } from "./booking";
import { logEvent } from "./events";
import { formatMoney } from "./format";
import { flushOutbox, METRIC, type Outbox } from "./messages";
import { normalizePhone } from "./phone";
import type { ShowroomCtx } from "./showroom";
import { storageDueCents } from "./storage";
import { addLocalDays, endOfLocalDay, formatDateTime, formatLongDate, startOfLocalDay, toLocalDate } from "./time";
import { encryptToken, generateToken, hashToken } from "./tokens";

export class UnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitError";
  }
}

async function withOutbox<T>(dbx: Db, fn: (tx: Tx, outbox: Outbox) => Promise<T>): Promise<T> {
  const outbox: Outbox = [];
  const result = await dbx.transaction((tx) => fn(tx, outbox));
  await flushOutbox(dbx, outbox);
  return result;
}

async function loadUnit(tx: Tx, unitId: string): Promise<{ unit: Unit; order: Order | null }> {
  const [unit] = await tx.select().from(units).where(eq(units.id, unitId)).for("update");
  if (!unit) throw new UnitError("Unit not found");
  const order = unit.orderId
    ? (await tx.select().from(orders).where(eq(orders.id, unit.orderId)).limit(1))[0] ?? null
    : null;
  return { unit, order };
}

/** terms_version defaults to 2 only when terms_v2_effective_date is set and order_date ≥ it. */
export function defaultTermsVersion(settings: ShowroomCtx["settings"], orderDate: string): 1 | 2 {
  const eff = settings.terms_v2_effective_date;
  return eff && orderDate >= eff ? 2 : 1;
}

export type OrderInput = {
  orderRef: string;
  source: "lightspeed" | "shopify" | "manual";
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  model: string;
  size?: string | null;
  colour?: string | null;
  orderDate: string;
  paymentStatus: "paid" | "deposit";
  balanceCents?: number;
  termsVersion?: 1 | 2;
  notes?: string | null;
  smsConsent?: boolean;
};

export async function createOrder(
  dbx: Db,
  showroom: ShowroomCtx,
  input: OrderInput,
  actor: string,
): Promise<Order> {
  const row: NewOrder = {
    showroomId: showroom.id,
    orderRef: input.orderRef.trim(),
    source: input.source,
    customerName: input.customerName.trim(),
    customerEmail: input.customerEmail?.trim().toLowerCase() || null,
    customerPhone: normalizePhone(input.customerPhone),
    smsConsent: input.smsConsent ?? false,
    model: input.model.trim(),
    size: input.size?.trim() || null,
    colour: input.colour?.trim() || null,
    orderDate: input.orderDate,
    paymentStatus: input.paymentStatus,
    balanceCents: input.balanceCents ?? 0,
    termsVersion: input.termsVersion ?? defaultTermsVersion(showroom.settings, input.orderDate),
    notes: input.notes?.trim() || null,
  };
  return dbx.transaction(async (tx) => {
    const [order] = await tx.insert(orders).values(row).returning();
    await logEvent(tx, {
      showroomId: showroom.id,
      orderId: order.id,
      type: "order_created",
      actor,
      payload: { source: order.source, order_ref: order.orderRef },
    });
    return order;
  });
}

/** Arrivals: tag a box to an open order. */
/**
 * A deferred order (R12) is waiting for the next shipment; receiving or attaching a bike to it
 * reopens it. Shared by receiveUnit and attachUnitTx.
 */
async function reopenIfDeferred(tx: Tx, order: Order, actor: string): Promise<Order> {
  if (order.status === "open") return order;
  if (order.status !== "deferred") throw new UnitError(`Order is ${order.status}, not open`);
  const [reopened] = await tx.update(orders).set({ status: "open", deferredAt: null }).where(eq(orders.id, order.id)).returning();
  await logEvent(tx, { showroomId: order.showroomId, orderId: order.id, type: "order_reopened", actor, payload: { from: "deferred" } });
  return reopened;
}

/**
 * Box tag is optional at receiving: when blank it defaults to the order reference (unique per
 * source) with a numeric suffix if that tag is already in use at this showroom.
 */
async function resolveBoxTag(tx: Tx, showroomId: string, requested: string, order: Order): Promise<string> {
  const base = requested.trim() || order.orderRef.trim();
  if (!base) throw new UnitError("Box tag is required when the order has no reference");
  const taken = new Set(
    (await tx.select({ boxTag: units.boxTag }).from(units).where(and(eq(units.showroomId, showroomId), sql`${units.boxTag} ilike ${base + "%"}`))).map(
      (r) => r.boxTag.toLowerCase(),
    ),
  );
  if (requested.trim() && taken.has(base.toLowerCase())) throw new UnitError(`Box tag ${base} is already in use at this showroom`);
  let tag = base;
  for (let i = 2; taken.has(tag.toLowerCase()); i++) tag = `${base}-${i}`;
  return tag;
}

export async function receiveUnit(
  dbx: Db,
  args: { showroom: ShowroomCtx; orderId: string; boxTag: string; actor: string; now?: Date },
): Promise<Unit> {
  const now = args.now ?? new Date();
  return dbx.transaction(async (tx) => {
    const [found] = await tx.select().from(orders).where(eq(orders.id, args.orderId)).for("update");
    if (!found) throw new UnitError("Order not found");
    const order = await reopenIfDeferred(tx, found, args.actor);
    const existing = await tx
      .select({ id: units.id })
      .from(units)
      .where(and(eq(units.orderId, order.id), inArray(units.status, ["received", "invited", "booked", "building", "ready"])));
    if (existing.length) throw new UnitError("This order already has a unit attached");
    const boxTag = await resolveBoxTag(tx, args.showroom.id, args.boxTag, order);
    const [unit] = await tx
      .insert(units)
      .values({
        showroomId: args.showroom.id,
        orderId: order.id,
        boxTag,
        model: order.model,
        size: order.size,
        colour: order.colour,
        status: "received",
        receivedAt: now,
      })
      .returning();
    await logEvent(tx, {
      showroomId: args.showroom.id,
      unitId: unit.id,
      orderId: order.id,
      type: "unit_received",
      actor: args.actor,
      payload: { box_tag: boxTag },
    });
    return unit;
  });
}

/** Shared by invite and re-attach: starts the clock and issues a fresh token. */
async function startClockTx(
  tx: Tx,
  outbox: Outbox,
  showroom: ShowroomCtx,
  unit: Unit,
  order: Order,
  actor: string,
  now: Date,
  eventType: "invite_sent" | "unit_reassigned",
  /** Staff booking flow: start the clock and mint the link without the Bike Arrived message. */
  silent = false,
): Promise<{ unit: Unit; token: string }> {
  if (!order.customerEmail && !order.customerPhone) {
    throw new UnitError("Order needs an email or phone before inviting");
  }
  const tz = showroom.timezone;
  const s = showroom.settings;
  const inviteDate = toLocalDate(now, tz);
  const token = generateToken();
  const [updated] = await tx
    .update(units)
    .set({
      status: "invited",
      orderId: order.id,
      invitedAt: now,
      bookBy: endOfLocalDay(addLocalDays(inviteDate, s.book_by_days), tz),
      pickupBy: endOfLocalDay(addLocalDays(inviteDate, s.pickup_by_days), tz),
      tokenHash: hashToken(token),
      tokenEnc: encryptToken(token),
      extensionCount: 0,
      noShowCount: 0,
      storageFrom: null,
      earlyBird: false,
    })
    .where(eq(units.id, unit.id))
    .returning();
  await logEvent(tx, {
    showroomId: showroom.id,
    unitId: unit.id,
    orderId: order.id,
    type: eventType,
    actor,
    payload: { book_by: updated.bookBy?.toISOString(), pickup_by: updated.pickupBy?.toISOString() },
  });
  const earlyBirdDeadline = s.early_bird_enabled
    ? formatDateTime(new Date(now.getTime() + s.early_bird_hours * 3_600_000), tz)
    : "";
  if (silent) return { unit: updated, token };
  outbox.push({
    showroom,
    unit: updated,
    order,
    metric: METRIC.bikeArrived,
    dedupeKey: `${eventType}:${now.toISOString()}`,
    actor,
    extra: {
      early_bird_deadline: earlyBirdDeadline,
      reward_text: s.early_bird_enabled ? s.early_bird_reward_text : "",
      days_left_display: `${s.pickup_by_days} days`,
    },
  });
  return { unit: updated, token };
}

export async function inviteUnit(
  dbx: Db,
  args: { showroom: ShowroomCtx; unitId: string; actor: string; now?: Date; silent?: boolean },
): Promise<{ unit: Unit; token: string }> {
  const now = args.now ?? new Date();
  return withOutbox(dbx, async (tx, outbox) => {
    const { unit, order } = await loadUnit(tx, args.unitId);
    if (unit.status !== "received") throw new UnitError(`Unit is ${unit.status}, not received`);
    if (!order) throw new UnitError("Unit has no order");
    return startClockTx(tx, outbox, args.showroom, unit, order, args.actor, now, "invite_sent", args.silent ?? false);
  });
}

export async function inviteAllReceived(
  dbx: Db,
  args: { showroom: ShowroomCtx; actor: string; now?: Date },
): Promise<{ invited: number; errors: string[] }> {
  const pending = await dbx
    .select({ id: units.id, boxTag: units.boxTag })
    .from(units)
    .where(and(eq(units.showroomId, args.showroom.id), eq(units.status, "received")));
  let invited = 0;
  const errors: string[] = [];
  for (const u of pending) {
    try {
      await inviteUnit(dbx, { ...args, unitId: u.id });
      invited++;
    } catch (err) {
      errors.push(`${u.boxTag}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { invited, errors };
}

/** Re-send the arrival message using the existing link (watchlist "Send invite again"). */
export async function resendInvite(
  dbx: Db,
  args: { showroom: ShowroomCtx; unitId: string; actor: string; now?: Date },
) {
  const now = args.now ?? new Date();
  const [unit] = await dbx.select().from(units).where(eq(units.id, args.unitId));
  if (!unit || unit.status !== "invited" || !unit.orderId) throw new UnitError("Only invited units can be re-sent");
  const [order] = await dbx.select().from(orders).where(eq(orders.id, unit.orderId));
  const s = args.showroom.settings;
  await logEvent(dbx, {
    showroomId: args.showroom.id,
    unitId: unit.id,
    orderId: order.id,
    type: "invite_resent",
    actor: args.actor,
  });
  return flushOutbox(dbx, [
    {
      showroom: args.showroom,
      unit,
      order,
      metric: METRIC.bikeArrived,
      dedupeKey: `resend:${now.toISOString()}`,
      actor: args.actor,
      extra: { reward_text: s.early_bird_enabled ? s.early_bird_reward_text : "", resend: true },
    },
  ]);
}

export async function startBuild(dbx: Db, args: { showroom: ShowroomCtx; unitId: string; actor: string }) {
  return dbx.transaction(async (tx) => {
    const { unit, order } = await loadUnit(tx, args.unitId);
    if (unit.status !== "booked") throw new UnitError(`Unit is ${unit.status}; only booked units go to Building`);
    const [active] = await tx
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(eq(appointments.unitId, unit.id), eq(appointments.status, "booked")));
    if (!active) throw new UnitError("R1: a unit is built only for a booked appointment");
    await tx.update(units).set({ status: "building" }).where(eq(units.id, unit.id));
    await logEvent(tx, {
      showroomId: args.showroom.id,
      unitId: unit.id,
      orderId: order?.id,
      appointmentId: active.id,
      type: "build_started",
      actor: args.actor,
    });
  });
}

export async function markReady(dbx: Db, args: { showroom: ShowroomCtx; unitId: string; actor: string }) {
  return dbx.transaction(async (tx) => {
    const { unit, order } = await loadUnit(tx, args.unitId);
    if (unit.status !== "building") throw new UnitError(`Unit is ${unit.status}; only building units become Ready`);
    await tx.update(units).set({ status: "ready" }).where(eq(units.id, unit.id));
    await logEvent(tx, {
      showroomId: args.showroom.id,
      unitId: unit.id,
      orderId: order?.id,
      type: "ready",
      actor: args.actor,
    });
  });
}

export const HANDOVER_CHECKLIST = [
  { key: "fit", label: "Fit: saddle, bars, reach" },
  { key: "display", label: "Display and ride modes explained" },
  { key: "app", label: "App pairing" },
  { key: "charging", label: "Charging routine and battery care" },
  { key: "accessories", label: "Accessories installed and checked" },
  { key: "warranty", label: "Warranty registration" },
  { key: "balance", label: "Balance collected in Lightspeed (if any)" },
] as const;

export type HandoverInput = {
  showroom: ShowroomCtx;
  unitId: string;
  actor: string;
  checklist: string[];
  storageCollectedCents: number;
  storageWaivedCents: number;
  waiveReason?: string | null;
  now?: Date;
};

export async function completeHandover(dbx: Db, args: HandoverInput) {
  const now = args.now ?? new Date();
  return withOutbox(dbx, async (tx, outbox) => {
    const { showroom } = args;
    const { unit, order } = await loadUnit(tx, args.unitId);
    if (!["booked", "building", "ready"].includes(unit.status)) {
      throw new UnitError(`Unit is ${unit.status}; cannot complete handover`);
    }
    const missing = HANDOVER_CHECKLIST.filter((c) => !args.checklist.includes(c.key));
    if (missing.length) throw new UnitError(`Checklist incomplete: ${missing.map((m) => m.label).join(", ")}`);
    const due = storageDueCents(unit, order?.termsVersion ?? 1, showroom.settings, now, showroom.timezone);
    if (due > 0 && args.storageCollectedCents + args.storageWaivedCents < due) {
      throw new UnitError(`Storage due is ${formatMoney(due)}; enter the collected and/or waived amount`);
    }
    if (args.storageWaivedCents > 0 && !args.waiveReason?.trim()) {
      throw new UnitError("A reason is required to waive storage");
    }
    const [active] = await tx
      .select()
      .from(appointments)
      .where(and(eq(appointments.unitId, unit.id), eq(appointments.status, "booked")));
    if (active) {
      await tx.update(appointments).set({ status: "completed" }).where(eq(appointments.id, active.id));
    }
    const [updated] = await tx
      .update(units)
      .set({
        status: "picked_up",
        pickedUpAt: now,
        storageCollectedCents: args.storageCollectedCents,
        storageWaivedCents: args.storageWaivedCents,
      })
      .where(eq(units.id, unit.id))
      .returning();
    if (order) await tx.update(orders).set({ status: "fulfilled" }).where(eq(orders.id, order.id));
    await logEvent(tx, {
      showroomId: showroom.id,
      unitId: unit.id,
      orderId: order?.id,
      appointmentId: active?.id,
      type: "picked_up",
      actor: args.actor,
      payload: { checklist: args.checklist, storage_due_cents: due },
    });
    if (args.storageCollectedCents > 0) {
      await logEvent(tx, {
        showroomId: showroom.id,
        unitId: unit.id,
        orderId: order?.id,
        type: "storage_collected",
        actor: args.actor,
        payload: { amount_cents: args.storageCollectedCents },
      });
    }
    if (args.storageWaivedCents > 0) {
      await logEvent(tx, {
        showroomId: showroom.id,
        unitId: unit.id,
        orderId: order?.id,
        type: "storage_waived",
        actor: args.actor,
        payload: { amount_cents: args.storageWaivedCents, reason: args.waiveReason },
      });
    }
    outbox.push({
      showroom,
      unit: updated,
      order,
      metric: METRIC.completed,
      dedupeKey: `picked_up:${now.toISOString()}`,
      actor: args.actor,
      extra: { picked_up_at_local: formatDateTime(now, showroom.timezone) },
    });
    return updated;
  });
}

/** R13: one extension per unit for managers; admins may grant a second. */
export async function grantExtension(
  dbx: Db,
  args: { showroom: ShowroomCtx; unitId: string; reason: string; user: StaffUser; now?: Date },
) {
  const now = args.now ?? new Date();
  if (!args.reason.trim()) throw new UnitError("A reason is required");
  return dbx.transaction(async (tx) => {
    const { showroom } = args;
    const { unit, order } = await loadUnit(tx, args.unitId);
    if (unit.status === "picked_up" || unit.status === "unassigned" || !unit.bookBy || !unit.pickupBy) {
      throw new UnitError("This unit cannot be extended");
    }
    const limit = hasRole(args.user.role, "admin") ? 2 : 1;
    if (unit.extensionCount >= limit) {
      throw new UnitError(
        unit.extensionCount >= 2 ? "Maximum extensions reached" : "A second extension requires the admin role",
      );
    }
    const days = showroom.settings.extension_days;
    const tz = showroom.timezone;
    const bookBy = endOfLocalDay(addLocalDays(toLocalDate(unit.bookBy, tz), days), tz);
    const pickupBy = endOfLocalDay(addLocalDays(toLocalDate(unit.pickupBy, tz), days), tz);
    // Storage that has not yet started chargeable days follows the new pick-up-by.
    const storageFrom =
      unit.storageFrom && unit.storageFrom > now
        ? startOfLocalDay(addLocalDays(toLocalDate(pickupBy, tz), 1), tz)
        : unit.storageFrom;
    const [updated] = await tx
      .update(units)
      .set({ bookBy, pickupBy, storageFrom, extensionCount: unit.extensionCount + 1 })
      .where(eq(units.id, unit.id))
      .returning();
    await logEvent(tx, {
      showroomId: showroom.id,
      unitId: unit.id,
      orderId: order?.id,
      type: "extension_granted",
      actor: args.user.id,
      payload: {
        reason: args.reason,
        days,
        book_by: bookBy.toISOString(),
        pickup_by: pickupBy.toISOString(),
        extension_number: unit.extensionCount + 1,
      },
    });
    return updated;
  });
}

export async function waiveStorage(
  dbx: Db,
  args: { showroom: ShowroomCtx; unitId: string; amountCents: number; reason: string; actor: string },
) {
  if (!args.reason.trim()) throw new UnitError("A reason is required");
  if (args.amountCents <= 0) throw new UnitError("Amount must be positive");
  return dbx.transaction(async (tx) => {
    const { unit, order } = await loadUnit(tx, args.unitId);
    await tx
      .update(units)
      .set({ storageWaivedCents: (unit.storageWaivedCents ?? 0) + args.amountCents })
      .where(eq(units.id, unit.id));
    await logEvent(tx, {
      showroomId: args.showroom.id,
      unitId: unit.id,
      orderId: order?.id,
      type: "storage_waived",
      actor: args.actor,
      payload: { amount_cents: args.amountCents, reason: args.reason },
    });
  });
}

export type DetachArgs = {
  showroom: ShowroomCtx;
  unitId: string;
  reason: "customer_deferred" | "released";
  actor: string;
  nextShipmentEta?: string | null;
  /** R18: required when releasing a terms v1 order. */
  customerAgreed?: boolean;
  staffReason?: string | null;
  now?: Date;
};

/** R11/R12: unit → unassigned, order → deferred, appointment cancelled without penalty. */
export async function detachUnitTx(tx: Tx, outbox: Outbox, args: DetachArgs): Promise<{ unit: Unit; order: Order }> {
  const { showroom, reason, actor } = args;
  const now = args.now ?? new Date();
  const { unit, order } = await loadUnit(tx, args.unitId);
  if (!order) throw new UnitError("Unit has no order");
  if (reason === "customer_deferred") {
    if (!showroom.settings.defer_enabled) throw new UnitError("Defer is not enabled");
    if (!["invited", "booked"].includes(unit.status)) throw new UnitError("Only invited or booked units can be deferred");
  } else {
    if (!showroom.settings.release_rule_enabled) throw new UnitError("Release rule is not enabled");
    if (unit.status !== "invited") throw new UnitError("Only unbooked (invited) units are releasable");
    if (!unit.bookBy || now <= unit.bookBy) throw new UnitError("Unit is not past its book-by date");
    if (order.termsVersion < 2 && !args.customerAgreed) {
      throw new UnitError("Terms v1 orders can only be released with the customer's agreement");
    }
    if (!args.staffReason?.trim()) throw new UnitError("A reason is required");
  }
  const [active] = await tx
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(eq(appointments.unitId, unit.id), eq(appointments.status, "booked")));
  if (active) {
    await cancelBookingTx(tx, outbox, { showroom, unitId: unit.id, reason: "deferred", actor, now, silent: true });
  }
  const [updated] = await tx
    .update(units)
    .set({ status: "unassigned", orderId: null })
    .where(eq(units.id, unit.id))
    .returning();
  const [deferredOrder] = await tx
    .update(orders)
    .set({ status: "deferred", deferredAt: now })
    .where(eq(orders.id, order.id))
    .returning();
  await logEvent(tx, {
    showroomId: showroom.id,
    unitId: unit.id,
    orderId: order.id,
    type: "unit_detached",
    actor,
    payload: {
      reason,
      customer_agreed: args.customerAgreed ?? null,
      staff_reason: args.staffReason ?? null,
      next_shipment_eta: args.nextShipmentEta ?? null,
    },
  });
  outbox.push({
    showroom,
    unit: { ...updated, orderId: order.id },
    order: deferredOrder,
    metric: METRIC.deferred,
    dedupeKey: `detached:${now.toISOString()}`,
    actor,
    extra: {
      reason,
      next_shipment_eta: args.nextShipmentEta ? ` (expected ${args.nextShipmentEta})` : "",
    },
  });
  return { unit: updated, order: deferredOrder };
}

export async function detachUnit(dbx: Db, args: DetachArgs) {
  return withOutbox(dbx, (tx, outbox) => detachUnitTx(tx, outbox, args));
}

/** Attach an unassigned unit to a waiting open order with the same model/size/colour and invite. */
export async function attachUnitTx(
  tx: Tx,
  outbox: Outbox,
  args: { showroom: ShowroomCtx; unitId: string; orderId: string; actor: string; now?: Date },
) {
  const now = args.now ?? new Date();
  const { unit } = await loadUnit(tx, args.unitId);
  if (unit.status !== "unassigned") throw new UnitError("Only unassigned units can be attached");
  const [found] = await tx.select().from(orders).where(eq(orders.id, args.orderId)).for("update");
  if (!found) throw new UnitError("Order not found");
  const order = await reopenIfDeferred(tx, found, args.actor);
  const same = (a: string | null, b: string | null) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
  if (!same(order.model, unit.model) || !same(order.size, unit.size) || !same(order.colour, unit.colour)) {
    throw new UnitError("Order does not match the unit's model, size and colour");
  }
  const taken = await tx
    .select({ id: units.id })
    .from(units)
    .where(and(eq(units.orderId, order.id), inArray(units.status, ["received", "invited", "booked", "building", "ready"])));
  if (taken.length) throw new UnitError("That order already has a unit");
  return startClockTx(tx, outbox, args.showroom, unit, order, args.actor, now, "unit_reassigned");
}

export async function attachUnit(
  dbx: Db,
  args: { showroom: ShowroomCtx; unitId: string; orderId: string; actor: string; now?: Date },
) {
  return withOutbox(dbx, (tx, outbox) => attachUnitTx(tx, outbox, args));
}

/** R11 re-tag: release from the original order and attach to the waitlist order in one transaction. */
export async function retagUnit(
  dbx: Db,
  args: {
    showroom: ShowroomCtx;
    unitId: string;
    toOrderId: string;
    actor: string;
    reason: string;
    customerAgreed: boolean;
    nextShipmentEta?: string | null;
    now?: Date;
  },
) {
  return withOutbox(dbx, async (tx, outbox) => {
    await detachUnitTx(tx, outbox, {
      showroom: args.showroom,
      unitId: args.unitId,
      reason: "released",
      actor: args.actor,
      staffReason: args.reason,
      customerAgreed: args.customerAgreed,
      nextShipmentEta: args.nextShipmentEta,
      now: args.now,
    });
    return attachUnitTx(tx, outbox, {
      showroom: args.showroom,
      unitId: args.unitId,
      orderId: args.toOrderId,
      actor: args.actor,
      now: args.now,
    });
  });
}

/** Waitlist = open orders with no unit attached. */
export async function waitlistFor(dbx: Db, showroomId: string, match?: Pick<Unit, "model" | "size" | "colour">) {
  const list = await dbx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.showroomId, showroomId),
        // Deferred orders keep their original order_date, so they sort to the front (R12 priority).
        inArray(orders.status, ["open", "deferred"]),
        notExists(
          dbx
            .select({ id: units.id })
            .from(units)
            .where(
              and(
                eq(units.orderId, orders.id),
                inArray(units.status, ["received", "invited", "booked", "building", "ready"]),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(orders.orderDate));
  if (!match) return list;
  const norm = (s: string | null) => (s ?? "").trim().toLowerCase();
  return list.filter(
    (o) => norm(o.model) === norm(match.model) && norm(o.size) === norm(match.size) && norm(o.colour) === norm(match.colour),
  );
}

export function describeClock(unit: Unit, tz: string) {
  return {
    bookBy: unit.bookBy ? formatLongDate(unit.bookBy, tz) : "—",
    pickupBy: unit.pickupBy ? formatLongDate(unit.pickupBy, tz) : "—",
  };
}

/**
 * Hard-delete a bike that should never have existed (test data, duplicate, wrong customer).
 * Manager-only at the action layer. Removes the unit, its appointments and events, and the order
 * when this was its only unit; frees any booked day's counter. Nothing is sent to the customer and
 * Lightspeed is not touched — close the work order there by hand. One `unit_deleted` event is kept
 * on the showroom (no unit/order id) so the deletion itself is still in the log.
 */
export async function deleteUnit(
  dbx: Db,
  args: { showroom: ShowroomCtx; unitId: string; actor: string; reason: string },
): Promise<{ boxTag: string; orderDeleted: boolean }> {
  return dbx.transaction(async (tx) => {
    const [unit] = await tx.select().from(units).where(and(eq(units.id, args.unitId), eq(units.showroomId, args.showroom.id))).limit(1);
    if (!unit) throw new Error("Bike not found");
    const [order] = unit.orderId ? await tx.select().from(orders).where(eq(orders.id, unit.orderId)).limit(1) : [undefined];
    const appts = await tx.select().from(appointments).where(eq(appointments.unitId, unit.id));
    for (const a of appts) if (a.status === "booked") await decrementCounter(tx, args.showroom.id, a.onDate);
    await tx.delete(events).where(eq(events.unitId, unit.id));
    await tx.delete(appointments).where(eq(appointments.unitId, unit.id));
    await tx.delete(units).where(eq(units.id, unit.id));
    let orderDeleted = false;
    if (order) {
      const [remaining] = await tx.select({ n: sql<number>`count(*)::int` }).from(units).where(eq(units.orderId, order.id));
      if (remaining.n === 0) {
        await tx.delete(events).where(eq(events.orderId, order.id));
        await tx.delete(orders).where(eq(orders.id, order.id));
        orderDeleted = true;
      }
    }
    await logEvent(tx, {
      showroomId: args.showroom.id,
      type: "unit_deleted",
      actor: args.actor,
      payload: {
        reason: args.reason,
        box_tag: unit.boxTag,
        model: unit.model,
        status: unit.status,
        customer_name: order?.customerName ?? null,
        order_ref: order?.orderRef ?? null,
        ls_workorder_id: unit.lsWorkorderId ?? null,
        order_deleted: orderDeleted,
      },
    });
    return { boxTag: unit.boxTag, orderDeleted };
  });
}

/**
 * Invite straight from the "On order" list: the box is received under the order's own reference
 * (so no separate Receive step) and the customer is texted their booking link. One order at a
 * time so a bike without contact details never blocks the rest.
 */
export async function inviteOrders(
  dbx: Db,
  args: { showroom: ShowroomCtx; orderIds: string[]; actor: string; now?: Date },
): Promise<{ invited: number; skipped: string[] }> {
  let invited = 0;
  const skipped: string[] = [];
  for (const orderId of args.orderIds) {
    const [order] = await dbx.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.showroomId, args.showroom.id)));
    if (!order) { skipped.push(`${orderId}: not found`); continue; }
    if (!order.customerEmail && !order.customerPhone) { skipped.push(`${order.customerName}: no phone or email on the order`); continue; }
    try {
      const existing = await dbx
        .select()
        .from(units)
        .where(and(eq(units.orderId, order.id), inArray(units.status, ["received", "invited", "booked", "building", "ready"])));
      const unit = existing[0] ?? (await receiveUnit(dbx, { showroom: args.showroom, orderId: order.id, boxTag: order.orderRef, actor: args.actor, now: args.now }));
      if (unit.status !== "received") { skipped.push(`${order.customerName}: already ${unit.status}`); continue; }
      await inviteUnit(dbx, { showroom: args.showroom, unitId: unit.id, actor: args.actor, now: args.now });
      invited++;
    } catch (err) {
      skipped.push(`${order.customerName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { invited, skipped };
}
