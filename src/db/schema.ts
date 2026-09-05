import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, pgTable, primaryKey, smallint, text, time, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const showrooms = pgTable("showrooms", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull(),
  addressLine: text("address_line").notNull(),
  phone: text("phone"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
});

export const staffUsers = pgTable(
  "staff_users",
  {
    id: id(),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    showroomId: uuid("showroom_id").references(() => showrooms.id),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [check("staff_users_role_check", sql`${t.role} in ('staff','manager','admin')`)],
);

export const magicLinks = pgTable("magic_links", {
  id: id(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  ...timestamps,
});

export const staffSessions = pgTable("staff_sessions", {
  id: id(),
  staffUserId: uuid("staff_user_id")
    .notNull()
    .references(() => staffUsers.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ...timestamps,
});

export const capacityRules = pgTable(
  "capacity_rules",
  {
    id: id(),
    showroomId: uuid("showroom_id")
      .notNull()
      .references(() => showrooms.id),
    weekday: smallint("weekday").notNull(),
    capacity: smallint("capacity").notNull(),
    windowStart: time("window_start").notNull(),
    windowEnd: time("window_end").notNull(),
    maxConcurrent: smallint("max_concurrent").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique("capacity_rules_showroom_weekday").on(t.showroomId, t.weekday),
    check("capacity_rules_weekday_check", sql`${t.weekday} between 0 and 6`),
    check("capacity_rules_capacity_check", sql`${t.capacity} >= 0`),
  ],
);

export const capacityOverrides = pgTable(
  "capacity_overrides",
  {
    id: id(),
    showroomId: uuid("showroom_id")
      .notNull()
      .references(() => showrooms.id),
    onDate: date("on_date").notNull(),
    capacity: smallint("capacity").notNull(),
    windowStart: time("window_start"),
    windowEnd: time("window_end"),
    maxConcurrent: smallint("max_concurrent"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    unique("capacity_overrides_showroom_date").on(t.showroomId, t.onDate),
    check("capacity_overrides_capacity_check", sql`${t.capacity} >= 0`),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: id(),
    showroomId: uuid("showroom_id")
      .notNull()
      .references(() => showrooms.id),
    orderRef: text("order_ref").notNull(),
    source: text("source").notNull(),
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email"),
    customerPhone: text("customer_phone"),
    smsConsent: boolean("sms_consent").notNull().default(false),
    model: text("model").notNull(),
    size: text("size"),
    colour: text("colour"),
    orderDate: date("order_date").notNull(),
    paymentStatus: text("payment_status").notNull(),
    balanceCents: integer("balance_cents").notNull().default(0),
    termsVersion: smallint("terms_version").notNull().default(1),
    status: text("status").notNull().default("open"),
    deferredAt: timestamp("deferred_at", { withTimezone: true }),
    notes: text("notes"),
    /** Lightspeed R-Series customerID once the order has been mirrored (README "Lightspeed bridge"). */
    lsCustomerId: text("ls_customer_id"),
    /** Lightspeed special-order SaleLine this order was synced from (uncompleted lines have saleID 0). */
    lsSaleLineId: text("ls_sale_line_id").unique(),
    ...timestamps,
  },
  (t) => [
    unique("orders_showroom_source_ref").on(t.showroomId, t.source, t.orderRef),
    check("orders_source_check", sql`${t.source} in ('lightspeed','shopify','manual')`),
    check("orders_payment_status_check", sql`${t.paymentStatus} in ('paid','deposit')`),
    check("orders_status_check", sql`${t.status} in ('open','deferred','fulfilled','cancelled')`),
  ],
);

export const units = pgTable(
  "units",
  {
    id: id(),
    showroomId: uuid("showroom_id")
      .notNull()
      .references(() => showrooms.id),
    orderId: uuid("order_id").references(() => orders.id),
    boxTag: text("box_tag").notNull(),
    model: text("model").notNull(),
    size: text("size"),
    colour: text("colour"),
    status: text("status").notNull().default("received"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    bookBy: timestamp("book_by", { withTimezone: true }),
    pickupBy: timestamp("pickup_by", { withTimezone: true }),
    extensionCount: smallint("extension_count").notNull().default(0),
    noShowCount: smallint("no_show_count").notNull().default(0),
    storageFrom: timestamp("storage_from", { withTimezone: true }),
    storageCollectedCents: integer("storage_collected_cents"),
    storageWaivedCents: integer("storage_waived_cents"),
    earlyBird: boolean("early_bird").notNull().default(false),
    tokenHash: text("token_hash").unique(),
    tokenEnc: text("token_enc"),
    pickedUpAt: timestamp("picked_up_at", { withTimezone: true }),
    /** Lightspeed work order mirroring this unit, and its Customer Item (Serialized) record. */
    lsWorkorderId: text("ls_workorder_id"),
    lsSerializedId: text("ls_serialized_id"),
    ...timestamps,
  },
  (t) => [
    unique("units_showroom_box_tag").on(t.showroomId, t.boxTag),
    check(
      "units_status_check",
      sql`${t.status} in ('received','invited','booked','building','ready','picked_up','unassigned')`,
    ),
  ],
);

export const appointments = pgTable(
  "appointments",
  {
    id: id(),
    showroomId: uuid("showroom_id")
      .notNull()
      .references(() => showrooms.id),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id),
    onDate: date("on_date").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("booked"),
    cancelledReason: text("cancelled_reason"),
    replacedBy: uuid("replaced_by"),
    createdBy: text("created_by").notNull(),
    ...timestamps,
  },
  (t) => [
    index("appointments_day_booked").on(t.showroomId, t.onDate).where(sql`status = 'booked'`),
    index("appointments_unit_booked").on(t.unitId).where(sql`status = 'booked'`),
    check(
      "appointments_status_check",
      sql`${t.status} in ('booked','completed','no_show','cancelled')`,
    ),
  ],
);

export const dayCounters = pgTable(
  "day_counters",
  {
    showroomId: uuid("showroom_id")
      .notNull()
      .references(() => showrooms.id),
    onDate: date("on_date").notNull(),
    bookedCount: integer("booked_count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.showroomId, t.onDate] })],
);

export const events = pgTable(
  "events",
  {
    id: id(),
    showroomId: uuid("showroom_id").notNull(),
    unitId: uuid("unit_id"),
    orderId: uuid("order_id"),
    appointmentId: uuid("appointment_id"),
    type: text("type").notNull(),
    actor: text("actor").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    klaviyoStatus: text("klaviyo_status"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("events_dedupe").on(t.unitId, t.type, sql`(${t.payload}->>'dedupe_key')`),
    index("events_unit_created").on(t.unitId, t.createdAt),
    index("events_order_created").on(t.orderId, t.createdAt),
  ],
);

/**
 * One row per connected Lightspeed R-Series account. Tokens are AES-GCM encrypted with
 * AUTH_SECRET (see src/lib/tokens.ts); refresh tokens rotate on every refresh, so this row
 * is the single source of truth and must be updated under a row lock.
 */
export const lightspeedConnections = pgTable("lightspeed_connections", {
  id: id(),
  accountId: text("account_id").notNull().unique(),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }).notNull(),
  scope: text("scope"),
  lastError: text("last_error"),
  ...timestamps,
});

export type Showroom = typeof showrooms.$inferSelect;
export type LightspeedConnection = typeof lightspeedConnections.$inferSelect;
export type StaffUser = typeof staffUsers.$inferSelect;
export type CapacityRule = typeof capacityRules.$inferSelect;
export type CapacityOverride = typeof capacityOverrides.$inferSelect;
/** Lightspeed work-order statuses (account-wide), mirrored for the Work orders page and custom views. */
export const lsWorkorderStatuses = pgTable("ls_workorder_statuses", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  systemValue: text("system_value"),
  sortOrder: integer("sort_order").notNull().default(0),
  htmlColor: text("html_color"),
  archived: boolean("archived").notNull().default(false),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Read-only mirror of the shop's open Lightspeed work orders (not paid, not archived). Refreshed by the
 * clock and the Sync button; rows that are no longer open are deleted. `unit_id` links the ones Kickstand
 * created (units.ls_workorder_id).
 */
export const lsWorkorders = pgTable(
  "ls_workorders",
  {
    id: text("id").primaryKey(), // Lightspeed workorderID
    showroomId: uuid("showroom_id")
      .notNull()
      .references(() => showrooms.id),
    statusId: integer("status_id").notNull(),
    customerId: text("customer_id"),
    customerName: text("customer_name").notNull().default(""),
    item: text("item").notNull().default(""),
    serial: text("serial"),
    note: text("note").notNull().default(""),
    hookIn: text("hook_in"),
    hookOut: text("hook_out"),
    employeeId: text("employee_id"),
    saleId: text("sale_id"),
    timeIn: timestamp("time_in", { withTimezone: true }),
    etaOut: timestamp("eta_out", { withTimezone: true }),
    lsUpdatedAt: timestamp("ls_updated_at", { withTimezone: true }),
    unitId: uuid("unit_id"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ls_workorders_showroom_status_idx").on(t.showroomId, t.statusId)],
);

/** A staff-defined view over the work-order mirror: a name plus the Lightspeed statuses it includes. */
export const workorderViews = pgTable("workorder_views", {
  id: id(),
  showroomId: uuid("showroom_id")
    .notNull()
    .references(() => showrooms.id),
  name: text("name").notNull(),
  statusIds: jsonb("status_ids").$type<number[]>().notNull().default([]),
  sortOrder: integer("sort_order").notNull().default(0),
  createdBy: text("created_by"),
  ...timestamps,
});

export type LsWorkorder = typeof lsWorkorders.$inferSelect;
export type LsWorkorderStatus = typeof lsWorkorderStatuses.$inferSelect;
export type WorkorderView = typeof workorderViews.$inferSelect;

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type Unit = typeof units.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type Event = typeof events.$inferSelect;

export type UnitStatus = Unit["status"] &
  ("received" | "invited" | "booked" | "building" | "ready" | "picked_up" | "unassigned");
export type Role = "staff" | "manager" | "admin";
