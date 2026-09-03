import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { events, type Order, type Unit } from "@/db/schema";
import { formatMoney, formatMoneyOrEmpty } from "./format";
import { lightspeedEnabled, syncUnitToLightspeed } from "./lightspeed";
import { logger } from "./logger";
import { getNotifier, type Profile } from "./notifier";
import type { ShowroomCtx } from "./showroom";
import { formatLongDate } from "./time";
import { decryptToken } from "./tokens";

export const METRIC = {
  bikeArrived: "Pickup: Bike Arrived",
  booked: "Pickup: Booked",
  rescheduled: "Pickup: Rescheduled",
  cancelled: "Pickup: Cancelled",
  reminder: "Pickup: Reminder Day Before",
  nudge3: "Pickup: Nudge Day 3",
  nudge7: "Pickup: Nudge Day 7",
  holdEnding: "Pickup: Hold Ending",
  storageStarted: "Pickup: Storage Started",
  missed: "Pickup: Missed",
  deferred: "Pickup: Deferred",
  completed: "Pickup: Completed",
} as const;

export type Metric = (typeof METRIC)[keyof typeof METRIC];

/** 'Pickup: Bike Arrived' → 'bike_arrived' (also the Lightspeed status-map key). */
export function metricKey(metric: string): string {
  return metric
    .replace(/^Pickup:\s*/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** 'Pickup: Bike Arrived' → 'msg_bike_arrived' */
export function metricEventType(metric: string): string {
  return "msg_" + metricKey(metric);
}

export function baseUrl(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function customerUrls(unit: Pick<Unit, "tokenEnc">) {
  if (!unit.tokenEnc) return null;
  const token = decryptToken(unit.tokenEnc);
  const root = `${baseUrl()}/b/${token}`;
  return {
    landing_url: root,
    booking_url: `${root}/book`,
    manage_url: `${root}/manage`,
    defer_url: `${root}/manage#defer`,
    rebook_url: `${root}/book`,
  };
}

export function commonProperties(
  showroom: ShowroomCtx,
  unit: Unit,
  order: Order | null,
): Record<string, unknown> {
  const tz = showroom.timezone;
  return {
    showroom: showroom.name,
    showroom_address: showroom.addressLine,
    showroom_phone: showroom.phone ?? "",
    order_ref: order?.orderRef ?? "",
    model: unit.model,
    size: unit.size ?? "",
    colour: unit.colour ?? "",
    ...(customerUrls(unit) ?? {}),
    book_by_date: unit.bookBy ? formatLongDate(unit.bookBy, tz) : "",
    pickup_by_date: unit.pickupBy ? formatLongDate(unit.pickupBy, tz) : "",
    payment_status: order?.paymentStatus ?? "",
    balance_display: formatMoneyOrEmpty(order?.balanceCents ?? 0),
    terms_version: order?.termsVersion ?? 1,
    sms_consent: order?.smsConsent ?? false,
    storage_rate_display: `${formatMoney(showroom.settings.storage_rate_cents)}/day`,
    storage_cap_display: formatMoney(showroom.settings.storage_cap_cents),
  };
}

export type MessageArgs = {
  showroom: ShowroomCtx;
  unit: Unit;
  /** The customer to notify. Pass explicitly when the unit has just been detached. */
  order: Order | null;
  metric: Metric;
  /** Local date for clock messages, appointment id for booking messages. */
  dedupeKey: string;
  extra?: Record<string, unknown>;
  actor?: string;
};

export type MessageOutcome = "sent" | "failed" | "skipped";

/**
 * Idempotent send: the msg_* event row is the dedupe lock (unique on unit, type, dedupe_key).
 * Call after the business transaction has committed.
 */
export async function sendUnitMessage(dbx: Db, args: MessageArgs): Promise<MessageOutcome> {
  const { showroom, unit, order, metric, dedupeKey, extra = {}, actor = "system" } = args;
  const type = metricEventType(metric);
  const properties = { ...commonProperties(showroom, unit, order), ...extra };

  const inserted = await dbx
    .insert(events)
    .values({
      showroomId: showroom.id,
      unitId: unit.id,
      orderId: order?.id ?? unit.orderId ?? null,
      type,
      actor,
      payload: { dedupe_key: dedupeKey, metric, properties },
    })
    .onConflictDoNothing()
    .returning({ id: events.id });
  if (inserted.length === 0) return "skipped";
  const eventId = inserted[0].id;

  const profile: Profile = {
    email: order?.customerEmail ?? null,
    phone: order?.customerPhone ?? null,
    name: order?.customerName ?? null,
    smsConsent: order?.smsConsent ?? false,
  };

  let status: "sent" | "failed" = "sent";
  let error: string | undefined;
  if (!profile.email && !profile.phone) {
    status = "failed";
    error = "no contact details";
  } else {
    try {
      await getNotifier().send(metric, profile, properties, `${unit.id}:${type}:${dedupeKey}`);
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
      logger.warn({ eventId, metric, unitId: unit.id, error }, "message send failed");
    }
  }
  // Lightspeed bridge: mirror the message as a work-order status so Ikeono texts from the
  // showroom number. Independent of the Klaviyo outcome; never fails the caller.
  let lightspeed: Record<string, unknown> | undefined;
  if (lightspeedEnabled(showroom)) {
    try {
      lightspeed = { ...(await syncUnitToLightspeed(dbx, { showroom, unit, order, metric })) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lightspeed = { error: message };
      logger.warn({ eventId, metric, unitId: unit.id, error: message }, "lightspeed sync failed");
    }
  }

  await dbx
    .update(events)
    .set({
      klaviyoStatus: status,
      payload: {
        dedupe_key: dedupeKey,
        metric,
        properties,
        ...(error ? { error } : {}),
        ...(lightspeed ? { lightspeed } : {}),
      },
    })
    .where(eq(events.id, eventId));
  return status;
}

/** Collected inside a transaction, flushed after commit. */
export type Outbox = MessageArgs[];

export async function flushOutbox(dbx: Db, outbox: Outbox): Promise<MessageOutcome[]> {
  const out: MessageOutcome[] = [];
  for (const m of outbox) out.push(await sendUnitMessage(dbx, m));
  return out;
}
