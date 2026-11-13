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

/**
 * A booking profile. `kind` "showroom" is a physical store (pickups, special orders, Lightspeed shop);
 * "online" is a team with no address (online sales: video and phone calls) that only has booking types.
 */
export const showrooms = pgTable("showrooms", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("showroom"),
  /** Google Calendar that this profile's bookings are copied to (shared with the service account in GOOGLE_SERVICE_ACCOUNT_JSON). */
  googleCalendarId: text("google_calendar_id"),
  /** Weekly hours booking types use by default ("Manage availability"), per weekday (0 = Sunday) a list of [start, end] "HH:MM". */
  bookingHours: jsonb("booking_hours").$type<Record<string, [string, string][]>>().notNull().default({}),
  timezone: text("timezone").notNull(),
  addressLine: text("address_line").notNull(),
  phone: text("phone"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (t) => [check("showrooms_kind_check", sql`${t.kind} in ('showroom','online')`)]);

export const staffUsers = pgTable(
  "staff_users",
  {
    id: id(),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    showroomId: uuid("showroom_id").references(() => showrooms.id),
    /** Other profiles this person works in besides their home store (e.g. floor staff who also take online calls). */
    extraShowroomIds: uuid("extra_showroom_ids").array().notNull().default(sql`'{}'::uuid[]`),
    active: boolean("active").notNull().default(true),
    /** Optional password sign-in (scrypt hash, see lib/passwords.ts). Null = Google / emailed link only. */
    passwordHash: text("password_hash"),
    passwordFailed: integer("password_failed").notNull().default(0),
    passwordLockedUntil: timestamp("password_locked_until", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [check("staff_users_role_check", sql`${t.role} in ('staff','manager','admin','owner')`)],
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
    /** "bike" (built, work order, capacity) or "parts" (accessories: no build, no work order, unlimited slots). */
    kind: text("kind").notNull().default("bike"),
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
    /** The note staff typed on that Lightspeed sale line ("wants the black rack", "call before build"). Synced, read-only here. */
    lsNote: text("ls_note"),
    /**
     * Orders staff linked with "Pick up together" (a couple buying under two names). Orders sharing it are
     * invited and booked as one visit, whoever's bike arrives first. The same person's orders need no link.
     */
    pickupGroup: uuid("pickup_group"),
    ...timestamps,
  },
  (t) => [
    index("orders_pickup_group").on(t.pickupGroup).where(sql`pickup_group is not null`),
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
    kind: text("kind").notNull().default("bike"),
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
    /** First time the customer opened their pickup link in a real browser (not a link preview, not staff). */
    linkOpenedAt: timestamp("link_opened_at", { withTimezone: true }),
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
    /** Several bikes collected in one visit share a group id: one message, one reminder, one slot time; capacity counts each bike. */
    groupId: uuid("group_id"),
    createdBy: text("created_by").notNull(),
    ...timestamps,
  },
  (t) => [
    index("appointments_day_booked").on(t.showroomId, t.onDate).where(sql`status = 'booked'`),
    index("appointments_unit_booked").on(t.unitId).where(sql`status = 'booked'`),
    index("appointments_group").on(t.groupId).where(sql`group_id is not null`),
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

/**
 * What customers can book with a profile (Calendly "event types"). `kind` "pickup" is the invite-only bike
 * pickup, whose slots still come from capacity_rules; "standard" types (test ride, service, video call…) use
 * the fields below. `hours` is weekly opening per weekday (0 = Sunday), each a list of [start, end] "HH:MM".
 * capacity_mode "bench" = up to bench_capacity bookings at once for the profile; "staff" = one per free staff member.
 */
export const bookingTypes = pgTable(
  "booking_types",
  {
    id: id(),
    showroomId: uuid("showroom_id")
      .notNull()
      .references(() => showrooms.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    kind: text("kind").notNull().default("standard"),
    access: text("access").notNull().default("public"),
    location: text("location").notNull().default("in_person"),
    durationMin: smallint("duration_min").notNull().default(30),
    bufferMin: smallint("buffer_min").notNull().default(0),
    slotStepMin: smallint("slot_step_min").notNull().default(30),
    noticeMin: integer("notice_min").notNull().default(240),
    horizonDays: smallint("horizon_days").notNull().default(60),
    capacityMode: text("capacity_mode").notNull().default("bench"),
    benchCapacity: smallint("bench_capacity").notNull().default(1),
    hours: jsonb("hours").$type<Record<string, [string, string][]>>().notNull().default({}),
    /** true = follow the profile's availability (showrooms.booking_hours); false = this type's own `hours`. */
    useStoreHours: boolean("use_store_hours").notNull().default(false),
    /** Colour key (see BOOKING_COLORS) for the type's row, the booking page and calendar blocks. */
    color: text("color").notNull().default("blue"),
    createsWorkOrder: boolean("creates_work_order").notNull().default(false),
    active: boolean("active").notNull().default(true),
    sortOrder: smallint("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    unique("booking_types_showroom_slug").on(t.showroomId, t.slug),
    check("booking_types_kind_check", sql`${t.kind} in ('standard','pickup')`),
    check("booking_types_access_check", sql`${t.access} in ('public','invite')`),
    check("booking_types_location_check", sql`${t.location} in ('in_person','video','phone')`),
    check("booking_types_capacity_mode_check", sql`${t.capacityMode} in ('bench','staff')`),
    check("booking_types_numbers_check", sql`${t.durationMin} between 5 and 480 and ${t.bufferMin} between 0 and 240 and ${t.slotStepMin} between 5 and 240 and ${t.noticeMin} >= 0 and ${t.horizonDays} between 1 and 365 and ${t.benchCapacity} between 1 and 50`),
  ],
);

/**
 * A customer's booking of a standard booking type (test ride, service, video call…). Bike pickups keep
 * using `appointments` (tied to a unit, day counters, storage); everything else lands here. `ends_at` is the
 * end of the appointment itself; the type's buffer is applied when checking overlaps. The manage link token
 * is stored hashed (lookup) and encrypted (to put it in later messages), like units.
 */
export const bookings = pgTable(
  "bookings",
  {
    id: id(),
    showroomId: uuid("showroom_id")
      .notNull()
      .references(() => showrooms.id),
    bookingTypeId: uuid("booking_type_id")
      .notNull()
      .references(() => bookingTypes.id),
    onDate: date("on_date").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("booked"),
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email"),
    customerPhone: text("customer_phone"),
    smsConsent: boolean("sms_consent").notNull().default(false),
    customerNote: text("customer_note").notNull().default(""),
    tokenHash: text("token_hash").notNull().unique(),
    tokenEnc: text("token_enc").notNull(),
    createdBy: text("created_by").notNull(),
    cancelledReason: text("cancelled_reason"),
    rescheduleCount: smallint("reschedule_count").notNull().default(0),
    lsWorkorderId: text("ls_workorder_id"),
    /** The copy of this booking on the profile's Google Calendar, and which calendar it is on. */
    googleEventId: text("google_event_id"),
    googleCalendarId: text("google_calendar_id"),
    ...timestamps,
  },
  (t) => [
    index("bookings_day_booked").on(t.showroomId, t.onDate).where(sql`status = 'booked'`),
    index("bookings_type_booked").on(t.bookingTypeId, t.startsAt).where(sql`status = 'booked'`),
    check("bookings_status_check", sql`${t.status} in ('booked','completed','no_show','cancelled')`),
    check("bookings_contact_check", sql`${t.customerEmail} is not null or ${t.customerPhone} is not null`),
  ],
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
export type BookingType = typeof bookingTypes.$inferSelect;
export type Booking = typeof bookings.$inferSelect;

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type Unit = typeof units.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type Event = typeof events.$inferSelect;

export type UnitStatus = Unit["status"] &
  ("received" | "invited" | "booked" | "building" | "ready" | "picked_up" | "unassigned");
export type Role = "staff" | "manager" | "admin" | "owner";
