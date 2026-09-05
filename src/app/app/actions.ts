"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { capacityOverrides, capacityRules, orders, units } from "@/db/schema";
import { requireActor, signOut } from "@/lib/auth";
import { BOOKING_ERROR_TEXT, BookingError, bookSlot, cancelBooking, recordNoShow, rescheduleBooking } from "@/lib/booking";
import { validateImport } from "@/lib/csv";
import { logEvent } from "@/lib/events";
import { bool, dollarsToCents, errorMessage, num, str, withFlash } from "@/lib/flash";
import { normalizePhone } from "@/lib/phone";
import { FLAG_KEYS, PROGRAM_KEYS, settingsSchema, validateSettings, type ProgramSettings } from "@/lib/settings";
import { getCapacityConfig, getShowroom, patchShowroomSettings } from "@/lib/showroom";
import { normalizeTime } from "@/lib/time";
import {
  attachUnit,
  completeHandover,
  createOrder,
  detachUnit,
  grantExtension,
  inviteAllReceived,
  inviteUnit,
  markReady,
  receiveUnit,
  resendInvite,
  retagUnit,
  startBuild,
  waiveStorage,
} from "@/lib/units";

/** Run a mutation and land back on `returnTo` with a flash; auth errors surface the same way. */
async function run(returnTo: string, fn: () => Promise<string | void>): Promise<never> {
  let flash: { ok?: string; error?: string };
  try {
    const ok = await fn();
    flash = ok ? { ok } : {};
  } catch (err) {
    flash = { error: errorMessage(err) };
  }
  redirect(withFlash(returnTo, flash));
}

function safeReturn(returnTo: string | undefined, fallback: string): string {
  return returnTo && returnTo.startsWith("/app") ? returnTo : fallback;
}

export async function signOutAction() {
  await signOut();
  redirect("/login");
}

// ---- Arrivals -------------------------------------------------------------

export async function receiveUnitAction(formData: FormData) {
  const q = str(formData, "q");
  return run(`/app/arrivals${q ? `?q=${encodeURIComponent(q)}` : ""}`, async () => {
    const user = await requireActor("staff");
    const showroom = await getShowroom(db);
    const unit = await receiveUnit(db, { showroom, orderId: str(formData, "order_id"), boxTag: str(formData, "box_tag"), actor: user.id });
    return `Received ${unit.boxTag}. Send the invite when ready.`;
  });
}

export async function createOrderAction(formData: FormData) {
  const ref = str(formData, "order_ref");
  return run(`/app/arrivals?q=${encodeURIComponent(ref)}`, async () => {
    const user = await requireActor("staff");
    const showroom = await getShowroom(db);
    const source = str(formData, "source");
    const paymentStatus = str(formData, "payment_status");
    if (!["lightspeed", "shopify", "manual"].includes(source)) throw new Error("Choose a source");
    if (!["paid", "deposit"].includes(paymentStatus)) throw new Error("Choose a payment status");
    const phoneRaw = str(formData, "customer_phone");
    if (phoneRaw && !normalizePhone(phoneRaw)) throw new Error("Phone number could not be normalised");
    if (!str(formData, "customer_email") && !phoneRaw) throw new Error("Email or phone is required");
    const termsRaw = str(formData, "terms_version");
    await createOrder(
      db,
      showroom,
      {
        orderRef: ref,
        source: source as "lightspeed" | "shopify" | "manual",
        customerName: str(formData, "customer_name"),
        customerEmail: str(formData, "customer_email") || null,
        customerPhone: phoneRaw || null,
        model: str(formData, "model"),
        size: str(formData, "size") || null,
        colour: str(formData, "colour") || null,
        orderDate: str(formData, "order_date"),
        paymentStatus: paymentStatus as "paid" | "deposit",
        balanceCents: dollarsToCents(formData, "balance"),
        termsVersion: termsRaw === "1" || termsRaw === "2" ? (Number(termsRaw) as 1 | 2) : undefined,
        notes: str(formData, "notes") || null,
        smsConsent: bool(formData, "sms_consent"),
      },
      user.id,
    );
    return `Order ${ref} created.`;
  });
}

export async function updateOrderAction(orderId: string, formData: FormData) {
  return run(`/app/orders/${orderId}`, async () => {
    const user = await requireActor("staff");
    const showroom = await getShowroom(db);
    const phoneRaw = str(formData, "customer_phone");
    const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
    if (phoneRaw && !phone) throw new Error("Phone number could not be normalised");
    const termsRaw = str(formData, "terms_version");
    const patch: Partial<typeof orders.$inferInsert> = {
      customerName: str(formData, "customer_name") || undefined,
      customerEmail: str(formData, "customer_email") || null,
      customerPhone: phone,
      smsConsent: bool(formData, "sms_consent"),
      balanceCents: dollarsToCents(formData, "balance"),
      notes: str(formData, "notes") || null,
    };
    if (termsRaw === "1" || termsRaw === "2") patch.termsVersion = Number(termsRaw);
    await db.update(orders).set(patch).where(and(eq(orders.id, orderId), eq(orders.showroomId, showroom.id)));
    await logEvent(db, { showroomId: showroom.id, orderId, type: "order_updated", actor: user.id, payload: { fields: Object.keys(patch) } });
    return "Order updated.";
  });
}

export async function inviteUnitAction(unitId: string, returnTo: string) {
  return run(safeReturn(returnTo, "/app/arrivals"), async () => {
    const user = await requireActor("staff");
    const showroom = await getShowroom(db);
    await inviteUnit(db, { showroom, unitId, actor: user.id });
    return "Invite sent. The clock has started.";
  });
}

export async function inviteAllAction() {
  return run("/app/arrivals", async () => {
    const user = await requireActor("staff");
    const showroom = await getShowroom(db);
    const { invited, errors } = await inviteAllReceived(db, { showroom, actor: user.id });
    if (errors.length) throw new Error(`Invited ${invited}; ${errors.length} failed: ${errors.join("; ")}`);
    return `Invited ${invited} customer${invited === 1 ? "" : "s"}.`;
  });
}

export async function resendInviteAction(unitId: string, returnTo: string) {
  return run(safeReturn(returnTo, `/app/units/${unitId}`), async () => {
    const user = await requireActor("staff");
    const showroom = await getShowroom(db);
    const [outcome] = await resendInvite(db, { showroom, unitId, actor: user.id });
    if (outcome === "failed") throw new Error("Message could not be delivered — check the customer's contact details");
    return "Invite re-sent.";
  });
}

// ---- Build board / floor --------------------------------------------------

export async function startBuildAction(unitId: string, returnTo: string) {
  return run(safeReturn(returnTo, "/app/build"), async () => {
    const user = await requireActor("staff");
    const showroom = await getShowroom(db);
    await startBuild(db, { showroom, unitId, actor: user.id });
    return "Marked as building.";
  });
}

export async function markReadyAction(unitId: string, returnTo: string) {
  return run(safeReturn(returnTo, "/app/build"), async () => {
    const user = await requireActor("staff");
    const showroom = await getShowroom(db);
    await markReady(db, { showroom, unitId, actor: user.id });
    return "Marked as ready.";
  });
}

export async function recordNoShowAction(unitId: string, returnTo: string) {
  return run(safeReturn(returnTo, "/app"), async () => {
    const user = await requireActor("staff");
    const showroom = await getShowroom(db);
    const res = await recordNoShow(db, { showroom, unitId, actor: user.id });
    return `No-show recorded (#${res.noShowCount}). The customer has been sent a rebook link.`;
  });
}

export async function completeHandoverAction(unitId: string, formData: FormData) {
  let error: string | null = null;
  try {
    const user = await requireActor("staff");
    const showroom = await getShowroom(db);
    await completeHandover(db, {
      showroom,
      unitId,
      actor: user.id,
      checklist: formData.getAll("checklist").map(String),
      storageCollectedCents: dollarsToCents(formData, "storage_collected"),
      storageWaivedCents: dollarsToCents(formData, "storage_waived"),
      waiveReason: str(formData, "waive_reason") || null,
    });
  } catch (err) {
    error = errorMessage(err);
  }
  if (error) redirect(withFlash(`/app/units/${unitId}?handover=1`, { error }));
  redirect(withFlash("/app", { ok: "Handover complete." }));
}

// ---- Manager actions ------------------------------------------------------

export async function grantExtensionAction(unitId: string, returnTo: string, formData: FormData) {
  return run(safeReturn(returnTo, `/app/units/${unitId}`), async () => {
    const user = await requireActor("manager");
    const showroom = await getShowroom(db);
    await grantExtension(db, { showroom, unitId, reason: str(formData, "reason"), user });
    return `Extended by ${showroom.settings.extension_days} days.`;
  });
}

export async function waiveStorageAction(unitId: string, returnTo: string, formData: FormData) {
  return run(safeReturn(returnTo, `/app/units/${unitId}`), async () => {
    const user = await requireActor("manager");
    const showroom = await getShowroom(db);
    await waiveStorage(db, { showroom, unitId, amountCents: dollarsToCents(formData, "amount"), reason: str(formData, "reason"), actor: user.id });
    return "Storage waived.";
  });
}

export async function retagUnitAction(unitId: string, returnTo: string, formData: FormData) {
  return run(safeReturn(returnTo, `/app/units/${unitId}`), async () => {
    const user = await requireActor("manager");
    const showroom = await getShowroom(db);
    const res = await retagUnit(db, {
      showroom,
      unitId,
      toOrderId: str(formData, "to_order_id"),
      actor: user.id,
      reason: str(formData, "reason"),
      customerAgreed: bool(formData, "customer_agreed"),
      nextShipmentEta: str(formData, "next_shipment_eta") || null,
    });
    return `Re-tagged and invited. New book-by ${res.unit.bookBy?.toDateString()}.`;
  });
}

export async function deferUnitAction(unitId: string, returnTo: string, formData: FormData) {
  return run(safeReturn(returnTo, `/app/units/${unitId}`), async () => {
    const user = await requireActor("manager");
    const showroom = await getShowroom(db);
    await detachUnit(db, { showroom, unitId, reason: "customer_deferred", actor: user.id, nextShipmentEta: str(formData, "next_shipment_eta") || null });
    return "Order deferred to the next shipment; unit is unassigned.";
  });
}

export async function attachUnitAction(unitId: string, returnTo: string, formData: FormData) {
  return run(safeReturn(returnTo, `/app/units/${unitId}`), async () => {
    const user = await requireActor("manager");
    const showroom = await getShowroom(db);
    await attachUnit(db, { showroom, unitId, orderId: str(formData, "order_id"), actor: user.id });
    return "Unit attached and the new customer invited.";
  });
}

// ---- Book pickup (staff, incl. the Lightspeed Custom Button) -------------

/**
 * Create the order (if needed), receive the box and mint the customer link in one go, then land
 * on the slot picker. Used when a customer is at the counter or on the phone and has no Kickstand
 * order yet. The Bike Arrived message is skipped (silent invite) because the booking follows
 * immediately; the Booked confirmation still goes out.
 */
export async function staffPrepareUnitAction(formData: FormData) {
  const back = `/app/book?${str(formData, "return_query")}`;
  let unitId: string | null = null;
  let error: string | null = null;
  try {
    const user = await requireActor("staff");
    const showroom = await getShowroom(db);
    let orderId = str(formData, "order_id");
    if (!orderId) {
      const phoneRaw = str(formData, "customer_phone");
      if (phoneRaw && !normalizePhone(phoneRaw)) throw new Error("Phone number could not be normalised");
      if (!str(formData, "customer_email") && !phoneRaw) throw new Error("Email or phone is required");
      const order = await createOrder(
        db,
        showroom,
        {
          orderRef: str(formData, "order_ref"),
          source: (str(formData, "source") || "lightspeed") as "lightspeed" | "shopify" | "manual",
          customerName: str(formData, "customer_name"),
          customerEmail: str(formData, "customer_email") || null,
          customerPhone: phoneRaw || null,
          model: str(formData, "model"),
          size: str(formData, "size") || null,
          colour: str(formData, "colour") || null,
          orderDate: str(formData, "order_date") || new Date().toISOString().slice(0, 10),
          paymentStatus: str(formData, "payment_status") === "deposit" ? "deposit" : "paid",
          balanceCents: dollarsToCents(formData, "balance"),
          smsConsent: bool(formData, "sms_consent"),
        },
        user.id,
      );
      const lsCustomerId = str(formData, "ls_customer_id");
      if (lsCustomerId) await db.update(orders).set({ lsCustomerId }).where(eq(orders.id, order.id));
      orderId = order.id;
    }
    const unit = await receiveUnit(db, { showroom, orderId, boxTag: str(formData, "box_tag"), actor: user.id });
    await inviteUnit(db, { showroom, unitId: unit.id, actor: user.id, silent: true });
    unitId = unit.id;
  } catch (err) {
    error = errorMessage(err);
  }
  if (error || !unitId) redirect(withFlash(back, { error: error ?? "Could not prepare the unit" }));
  redirect(`/app/book?unit=${unitId}`);
}

/** Staff cancels on the customer's behalf. "customer" applies the late-change rule and texts the
 *  customer a cancellation; "staff" is silent and never counts as a no-show. */
type StaffCancelReason = "customer" | "shop" | "staff";
function cancelReason(v: string): StaffCancelReason {
  return v === "staff" || v === "shop" ? v : "customer";
}

export async function staffCancelBookingAction(unitId: string, returnTo: string, formData: FormData) {
  const reason = cancelReason(str(formData, "reason"));
  return run(safeReturn(returnTo, `/app/units/${unitId}`), async () => {
    const user = await requireActor("staff");
    const showroom = await getShowroom(db);
    const res = await cancelBooking(db, { showroom, unitId, reason, actor: user.id });
    if (reason === "staff") return "Booking cancelled. No message was sent; the bike is back to invited.";
    if (reason === "shop") return "Booking cancelled. The customer has been told we had to cancel and sent a link to pick a new time.";
    return res.lateChange
      ? "Booking cancelled inside the cutoff — it counts as a missed pickup. The customer has been sent a rebook link."
      : "Booking cancelled. The customer has been sent a message with their rebook link.";
  });
}

/**
 * Bulk actions from the Bikes page: the selected unit ids arrive as repeated `unit_ids` fields
 * (checkboxes bound to the form with the `form` attribute) and `op` says what to do. Each bike is
 * processed on its own so one failure (no contact details, not booked, …) never blocks the rest;
 * the flash reports how many went through and why the others were skipped.
 */
export async function bulkBikesAction(returnTo: string, formData: FormData) {
  const ids = formData.getAll("unit_ids").map(String).filter(Boolean);
  const op = str(formData, "op");
  const reason = cancelReason(str(formData, "reason"));
  return run(safeReturn(returnTo, "/app/bikes"), async () => {
    const user = await requireActor("staff");
    const showroom = await getShowroom(db);
    if (ids.length === 0) throw new Error("Tick at least one bike first.");
    let done = 0;
    const skipped: string[] = [];
    for (const unitId of ids) {
      try {
        if (op === "invite") await inviteUnit(db, { showroom, unitId, actor: user.id });
        else if (op === "build") await startBuild(db, { showroom, unitId, actor: user.id });
        else if (op === "ready") await markReady(db, { showroom, unitId, actor: user.id });
        else if (op === "cancel") await cancelBooking(db, { showroom, unitId, reason, actor: user.id });
        else throw new Error(`Unknown bulk action "${op}"`);
        done++;
      } catch (err) {
        const [u] = await db.select({ boxTag: units.boxTag }).from(units).where(eq(units.id, unitId));
        skipped.push(`${u?.boxTag ?? unitId}: ${err instanceof BookingError ? BOOKING_ERROR_TEXT[err.code] : errorMessage(err)}`);
      }
    }
    const verb = { invite: "Invites sent", build: "Marked building", ready: "Marked ready", cancel: "Bookings cancelled" }[op] ?? "Done";
    const tail = skipped.length ? ` · skipped ${skipped.length}: ${skipped.slice(0, 3).join("; ")}${skipped.length > 3 ? "; …" : ""}` : "";
    if (op === "cancel" && done > 0) {
      return `${verb}: ${done}${reason === "staff" ? " (no messages sent)" : reason === "shop" ? " (customers told we had to cancel, with a rebook link)" : " (customers sent a rebook link)"}${tail}`;
    }
    return `${verb}: ${done}${tail}`;
  });
}

/** Staff moves an existing booking to a new slot (customer-requested; the late-change rule applies). */
export async function staffRescheduleAction(unitId: string, formData: FormData) {
  const startsAt = new Date(str(formData, "starts_at"));
  const back = `/app/book?unit=${unitId}&reschedule=1`;
  if (Number.isNaN(startsAt.getTime())) redirect(withFlash(back, { error: "Pick a time first." }));
  let error: string | null = null;
  let late = false;
  try {
    const user = await requireActor("staff");
    const showroom = await getShowroom(db);
    const res = await rescheduleBooking(db, { showroom, unitId, startsAt, actor: user.id, smsConsent: bool(formData, "sms_consent") });
    late = res.lateChange;
  } catch (err) {
    error = err instanceof BookingError ? BOOKING_ERROR_TEXT[err.code] : errorMessage(err);
  }
  if (error) redirect(withFlash(back, { error }));
  redirect(withFlash(`/app/units/${unitId}`, { ok: late ? "Pickup moved inside the cutoff — counted as a missed pickup. The customer has been sent the new time." : "Pickup moved. The customer has been sent the new time." }));
}

export async function staffBookAction(unitId: string, formData: FormData) {
  const startsAt = new Date(str(formData, "starts_at"));
  const back = `/app/book?unit=${unitId}`;
  if (Number.isNaN(startsAt.getTime())) redirect(withFlash(back, { error: "Pick a time first." }));
  let error: string | null = null;
  try {
    const user = await requireActor("staff");
    const showroom = await getShowroom(db);
    await bookSlot(db, {
      showroom,
      unitId,
      startsAt,
      createdBy: user.id,
      smsConsent: bool(formData, "sms_consent"),
      allowShortNotice: bool(formData, "short_notice"),
    });
  } catch (err) {
    error = err instanceof BookingError ? BOOKING_ERROR_TEXT[err.code] : errorMessage(err);
  }
  if (error) redirect(withFlash(back, { error }));
  redirect(withFlash(`/app/units/${unitId}`, { ok: "Pickup booked. The customer has been sent the confirmation." }));
}

// ---- Settings -------------------------------------------------------------

export async function saveCapacityTemplateAction(formData: FormData) {
  return run("/app/settings/capacity", async () => {
    const user = await requireActor("manager");
    const showroom = await getShowroom(db);
    const before = await getCapacityConfig(db, showroom.id);
    const changes: Record<string, unknown> = {};
    for (let weekday = 0; weekday <= 6; weekday++) {
      const closed = bool(formData, `closed_${weekday}`);
      const capacity = closed ? 0 : Math.max(0, Math.floor(num(formData, `capacity_${weekday}`)));
      const windowStart = normalizeTime(str(formData, `start_${weekday}`) || "12:00");
      const windowEnd = normalizeTime(str(formData, `end_${weekday}`) || "17:15");
      const maxConcurrent = Math.max(1, Math.floor(num(formData, `mc_${weekday}`, 1)));
      if (capacity > 0 && windowStart >= windowEnd) throw new Error(`Weekday ${weekday}: window start must be before window end`);
      const row = { showroomId: showroom.id, weekday, capacity, windowStart, windowEnd, maxConcurrent };
      await db
        .insert(capacityRules)
        .values(row)
        .onConflictDoUpdate({ target: [capacityRules.showroomId, capacityRules.weekday], set: { capacity, windowStart, windowEnd, maxConcurrent } });
      const prev = before.rules.find((r) => r.weekday === weekday);
      if (!prev || prev.capacity !== capacity || normalizeTime(prev.windowStart) !== windowStart || normalizeTime(prev.windowEnd) !== windowEnd || prev.maxConcurrent !== maxConcurrent) {
        changes[`weekday_${weekday}`] = { from: prev ? { capacity: prev.capacity, window: `${prev.windowStart}-${prev.windowEnd}`, mc: prev.maxConcurrent } : null, to: { capacity, window: `${windowStart}-${windowEnd}`, mc: maxConcurrent } };
      }
    }
    if (Object.keys(changes).length) {
      await logEvent(db, { showroomId: showroom.id, type: "settings_changed", actor: user.id, payload: { area: "capacity_template", changes } });
    }
    return "Weekly template saved.";
  });
}

export async function upsertOverrideAction(formData: FormData) {
  return run("/app/settings/capacity", async () => {
    const user = await requireActor("manager");
    const showroom = await getShowroom(db);
    const onDate = str(formData, "on_date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(onDate)) throw new Error("Pick a date");
    const closed = bool(formData, "closed");
    const capacity = closed ? 0 : Math.max(0, Math.floor(num(formData, "capacity")));
    const windowStart = str(formData, "start") ? normalizeTime(str(formData, "start")) : null;
    const windowEnd = str(formData, "end") ? normalizeTime(str(formData, "end")) : null;
    const mcRaw = str(formData, "mc");
    const maxConcurrent = mcRaw ? Math.max(1, Math.floor(Number(mcRaw))) : null;
    const note = str(formData, "note") || null;
    if (windowStart && windowEnd && windowStart >= windowEnd) throw new Error("Window start must be before window end");
    await db
      .insert(capacityOverrides)
      .values({ showroomId: showroom.id, onDate, capacity, windowStart, windowEnd, maxConcurrent, note })
      .onConflictDoUpdate({ target: [capacityOverrides.showroomId, capacityOverrides.onDate], set: { capacity, windowStart, windowEnd, maxConcurrent, note } });
    await logEvent(db, { showroomId: showroom.id, type: "settings_changed", actor: user.id, payload: { area: "capacity_override", changes: { [onDate]: { capacity, windowStart, windowEnd, maxConcurrent, note } } } });
    return `Override saved for ${onDate}.`;
  });
}

export async function deleteOverrideAction(id: string) {
  return run("/app/settings/capacity", async () => {
    const user = await requireActor("manager");
    const showroom = await getShowroom(db);
    const [row] = await db.delete(capacityOverrides).where(and(eq(capacityOverrides.id, id), eq(capacityOverrides.showroomId, showroom.id))).returning();
    if (row) await logEvent(db, { showroomId: showroom.id, type: "settings_changed", actor: user.id, payload: { area: "capacity_override", changes: { [row.onDate]: { removed: true } } } });
    return "Override removed.";
  });
}

export async function saveProgramSettingsAction(formData: FormData) {
  return run("/app/settings/program", async () => {
    const user = await requireActor("manager");
    const showroom = await getShowroom(db);
    const current = showroom.settings;
    const next: Record<string, unknown> = { ...current };
    for (const key of PROGRAM_KEYS) {
      const raw = str(formData, key);
      if (key === "early_bird_reward_text") next[key] = raw;
      else if (key === "terms_v2_effective_date") next[key] = raw || null;
      else {
        if (raw === "") throw new Error(`${key} is required`);
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
        next[key] = ["min_lead_hours", "reschedule_cutoff_hours", "early_bird_hours"].includes(key) ? n : Math.round(n);
      }
    }
    if (user.role === "admin") {
      for (const key of FLAG_KEYS) next[key] = bool(formData, key);
    }
    const parsed = settingsSchema.safeParse(next);
    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const errors = validateSettings(parsed.data);
    if (errors.length) throw new Error(errors.join(" "));
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of [...PROGRAM_KEYS, ...FLAG_KEYS] as (keyof ProgramSettings)[]) {
      if (JSON.stringify(current[key]) !== JSON.stringify(parsed.data[key])) changes[key] = { from: current[key], to: parsed.data[key] };
    }
    if (Object.keys(changes).length === 0) return "No changes.";
    const patch: Partial<ProgramSettings> = {};
    for (const key of Object.keys(changes) as (keyof ProgramSettings)[]) (patch as Record<string, unknown>)[key] = parsed.data[key];
    await patchShowroomSettings(db, showroom.id, patch);
    await logEvent(db, { showroomId: showroom.id, type: "settings_changed", actor: user.id, payload: { area: "program", changes } });
    return `Saved ${Object.keys(changes).length} change${Object.keys(changes).length === 1 ? "" : "s"}.`;
  });
}

// ---- CSV import (useActionState) ------------------------------------------

export type ImportState = {
  stage: "idle" | "preview" | "done";
  text?: string;
  valid?: number;
  errors?: { row: number; message: string }[];
  imported?: number;
  error?: string;
  sample?: { row: number; customer: string; model: string; orderRef: string }[];
};

export async function importCsvAction(_prev: ImportState, formData: FormData): Promise<ImportState> {
  try {
    const user = await requireActor("manager");
    const showroom = await getShowroom(db);
    const file = formData.get("file");
    let text = str(formData, "text");
    if (file instanceof File && file.size > 0) text = await file.text();
    if (!text) return { stage: "idle", error: "Choose a CSV file" };
    if (text.length > 2_000_000) return { stage: "idle", error: "File too large (2 MB max)" };
    const existing = await db.select({ source: orders.source, orderRef: orders.orderRef }).from(orders).where(eq(orders.showroomId, showroom.id));
    const result = validateImport(text, new Set(existing.map((e) => `${e.source}:${e.orderRef}`)));
    if (str(formData, "commit") !== "1") {
      return {
        stage: "preview",
        text,
        valid: result.valid.length,
        errors: result.errors,
        sample: result.valid.slice(0, 10).map((v) => ({ row: v.row, customer: v.input.customerName, model: v.input.model, orderRef: v.input.orderRef })),
      };
    }
    let imported = 0;
    for (const v of result.valid) {
      await createOrder(db, showroom, v.input, user.id);
      imported++;
    }
    await logEvent(db, { showroomId: showroom.id, type: "csv_imported", actor: user.id, payload: { imported, rejected: result.errors.length } });
    return { stage: "done", imported, errors: result.errors };
  } catch (err) {
    return { stage: "idle", error: errorMessage(err) };
  }
}
