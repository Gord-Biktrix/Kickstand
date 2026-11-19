/**
 * Booking types: what customers can book with a profile (a showroom or the online sales team), like
 * Calendly's event types. Pure helpers (presets, hours, validation) sit at the top so they unit-test without
 * a database; the DB functions follow. The bike pickup is a booking type too (kind "pickup"), but its slots
 * still come from Settings › Capacity, so only its name, description and on/off switch are edited here.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { SUGGESTED_CALL_QUESTIONS, SUGGESTED_SERVICE_QUESTIONS, type BookingQuestion } from "./booking-questions";
import type { DbOrTx } from "@/db/client";
import { bookingTypes, capacityRules, showrooms, type BookingType, type CapacityRule } from "@/db/schema";

export type BookingLocation = "in_person" | "video" | "phone";
export type BookingAccess = "public" | "invite";
export type CapacityMode = "bench" | "staff";
export type WeeklyHours = Record<string, [string, string][]>;

export const LOCATION_LABEL: Record<BookingLocation, string> = { in_person: "In person", video: "Video call", phone: "Phone call" };

/** Words for "it happened": a visit is checked in, a phone or video call is done. */
export function doneWords(location: string): { action: string; done: string } {
  return location === "in_person" ? { action: "Check in", done: "checked in" } : { action: "Mark as done", done: "done" };
}
export const ACCESS_LABEL: Record<BookingAccess, string> = { public: "Anyone (public booking page)", invite: "Invite link only" };
export const CAPACITY_LABEL: Record<CapacityMode, string> = { bench: "Bench: a set number at the same time", staff: "Per staff member: one each" };
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Mon–Fri 8am–4pm: the online sales team's hours (Gord, 2026-11-12) and a sensible start for a new type. */
export const WEEKDAY_8_TO_4: WeeklyHours = { "1": [["08:00", "16:00"]], "2": [["08:00", "16:00"]], "3": [["08:00", "16:00"]], "4": [["08:00", "16:00"]], "5": [["08:00", "16:00"]] };

/**
 * Starting values for a new type, standing in for YouCanBookMe's defaults (YCBM is switched off, so its
 * exact settings couldn't be copied): 30-minute bookings on a 30-minute grid, no buffer, at least 4 hours'
 * notice, up to 60 days ahead. Every value is editable per type.
 */
/** Colours a type can take (row bar, booking page accent, calendar blocks). Hex values chosen to read on white. */
export const BOOKING_COLORS = {
  blue: { label: "Blue", hex: "#2563eb", soft: "#dbeafe" },
  orange: { label: "Orange", hex: "#c2410c", soft: "#ffedd5" },
  green: { label: "Green", hex: "#15803d", soft: "#dcfce7" },
  purple: { label: "Purple", hex: "#7c3aed", soft: "#ede9fe" },
  teal: { label: "Teal", hex: "#0f766e", soft: "#ccfbf1" },
  pink: { label: "Pink", hex: "#be185d", soft: "#fce7f3" },
  amber: { label: "Amber", hex: "#b45309", soft: "#fef3c7" },
  slate: { label: "Grey", hex: "#475569", soft: "#f1f5f9" },
} as const;
export type BookingColor = keyof typeof BOOKING_COLORS;
export const isBookingColor = (v: string): v is BookingColor => v in BOOKING_COLORS;
export function colorOf(key: string | null | undefined) {
  return BOOKING_COLORS[key && isBookingColor(key) ? key : "orange"];
}

/** Lengths offered as one click in the editor (Calendly-style); any other number goes in "Custom". */
export const DURATION_CHOICES = [15, 30, 45, 60, 90, 120] as const;

export const NEW_TYPE_DEFAULTS = { durationMin: 30, bufferMin: 0, slotStepMin: 30, noticeMin: 240, horizonDays: 60, benchCapacity: 1 } as const;

export type Preset = {
  key: string;
  name: string;
  description: string;
  location: BookingLocation;
  durationMin: number;
  createsWorkOrder: boolean;
  color: BookingColor;
  /** Which profile kinds the preset makes sense for. */
  for: ("showroom" | "online")[];
};

export const PRESETS: Preset[] = [
  { key: "test-ride", name: "Test ride", description: "Try a bike at the showroom with one of our team.", location: "in_person", durationMin: 45, createsWorkOrder: false, color: "orange", for: ["showroom"] },
  { key: "service", name: "Service appointment", description: "Bring your bike in for a tune-up or repair.", location: "in_person", durationMin: 60, createsWorkOrder: true, color: "amber", for: ["showroom"] },
  { key: "showroom-visit", name: "Showroom visit", description: "Come in and talk to an expert about the right bike for you.", location: "in_person", durationMin: 30, createsWorkOrder: false, color: "green", for: ["showroom"] },
  { key: "video-call", name: "Video call with an expert", description: "A live video tour of the bikes with a product expert.", location: "video", durationMin: 30, createsWorkOrder: false, color: "purple", for: ["online"] },
  { key: "phone-call", name: "Phone call with an expert", description: "We call you to answer questions and help you choose.", location: "phone", durationMin: 30, createsWorkOrder: false, color: "teal", for: ["online"] },
];

export function presetsFor(kind: string): Preset[] {
  return PRESETS.filter((p) => p.for.includes(kind === "online" ? "online" : "showroom"));
}

export function typeSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "booking";
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function normTime(raw: string): string | null {
  const m = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?$/i.exec(raw.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ?? "00";
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  const t = `${String(h).padStart(2, "0")}:${min}`;
  return HHMM.test(t) ? t : null;
}

/**
 * One weekday's hours from what staff type: "8:00-16:00", "9am-12pm, 1pm-5pm", or blank for closed.
 * Ranges must run forwards and not overlap.
 */
export function parseDayHours(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [a, b, extra] = part.split(/\s*[-–]\s*/);
    const start = a ? normTime(a) : null;
    const end = b ? normTime(b) : null;
    if (!start || !end || extra !== undefined) throw new Error(`"${part}" isn't a time range. Write it like 8:00-16:00 or 9am-5pm.`);
    if (toMin(end) <= toMin(start)) throw new Error(`"${part}" ends before it starts.`);
    out.push([start, end]);
  }
  out.sort((x, y) => toMin(x[0]) - toMin(y[0]));
  for (let i = 1; i < out.length; i++) {
    if (toMin(out[i][0]) < toMin(out[i - 1][1])) throw new Error(`${out[i - 1].join("-")} and ${out[i].join("-")} overlap.`);
  }
  return out;
}

/**
 * Weekly hours from the HoursEditor's fields: each ticked day takes its first range and, when both times are
 * filled, a second one. A bad day names itself in the error.
 */
export function hoursFromForm(get: (name: string) => string, prefix = ""): WeeklyHours {
  const out: WeeklyHours = {};
  for (let wd = 0; wd < 7; wd++) {
    const on = get(`${prefix}day_${wd}`);
    if (on !== "on" && on !== "true" && on !== "1") continue;
    const parts = [[get(`${prefix}s1_${wd}`), get(`${prefix}e1_${wd}`)], [get(`${prefix}s2_${wd}`), get(`${prefix}e2_${wd}`)]]
      .filter(([a, b]) => a && b)
      .map(([a, b]) => `${a}-${b}`);
    try {
      const ranges = parseDayHours(parts.join(", "));
      if (!ranges.length) throw new Error("ticked but no times set.");
      out[String(wd)] = ranges;
    } catch (err) {
      throw new Error(`${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][wd]}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

export function formatDayHours(ranges: [string, string][] | undefined): string {
  return (ranges ?? []).map(([a, b]) => `${a}-${b}`).join(", ");
}

/** Weekly hours from seven text fields (index 0 = Sunday). A bad day names itself in the error. */
export function parseWeeklyHours(days: string[]): WeeklyHours {
  const out: WeeklyHours = {};
  days.forEach((text, wd) => {
    try {
      const ranges = parseDayHours(text ?? "");
      if (ranges.length) out[String(wd)] = ranges;
    } catch (err) {
      throw new Error(`${WEEKDAYS[wd]}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return out;
}

export function hoursSummary(hours: WeeklyHours): string {
  const days = WEEKDAYS.map((d, wd) => ({ d, h: formatDayHours(hours[String(wd)]) })).filter((x) => x.h);
  if (!days.length) return "No hours set";
  const groups: { from: string; to: string; h: string }[] = [];
  for (const x of days) {
    const last = groups.at(-1);
    const prevIdx = last ? WEEKDAYS.indexOf(last.to as (typeof WEEKDAYS)[number]) : -2;
    if (last && last.h === x.h && WEEKDAYS.indexOf(x.d) === prevIdx + 1) last.to = x.d;
    else groups.push({ from: x.d, to: x.d, h: x.h });
  }
  return groups.map((g) => `${g.from === g.to ? g.from : `${g.from}–${g.to}`} ${g.h}`).join(" · ");
}

export type BookingTypeInput = {
  name: string;
  description: string;
  location: BookingLocation;
  access: BookingAccess;
  durationMin: number;
  bufferMin: number;
  slotStepMin: number;
  noticeMin: number;
  horizonDays: number;
  capacityMode: CapacityMode;
  benchCapacity: number;
  hours: WeeklyHours;
  createsWorkOrder: boolean;
  /** Listed in the all-showrooms directory (/book/all/<slug>). */
  inDirectory?: boolean;
  /** Follow the profile's availability instead of `hours`. */
  useStoreHours?: boolean;
  color?: string;
  /** Booking form questions (src/lib/booking-questions.ts); left as is when omitted. */
  questions?: BookingQuestion[];
  /** Staff shown with photos on the booking page; left as is when omitted. */
  hostIds?: string[];
};

/** The weekly hours a type is actually bookable in: the profile's availability, or its own custom hours. */
export function effectiveHours(type: Pick<BookingType, "useStoreHours" | "hours">, profileHours: WeeklyHours | null | undefined): WeeklyHours {
  return type.useStoreHours ? (profileHours ?? {}) : (type.hours as WeeklyHours);
}

const isLocation = (v: string): v is BookingLocation => v === "in_person" || v === "video" || v === "phone";

/** Check a standard type's fields; returns the cleaned input or throws with one plain sentence. */
export function validateBookingType(raw: BookingTypeInput, profileKind: string): BookingTypeInput {
  const name = raw.name.trim();
  if (!name) throw new Error("Give the booking type a name.");
  if (name.length > 80) throw new Error("Keep the name under 80 characters.");
  if (!isLocation(raw.location)) throw new Error("Pick where the appointment happens.");
  if (profileKind === "online" && raw.location === "in_person") throw new Error("The online team has no address, so its bookings must be video or phone calls.");
  if (raw.access !== "public" && raw.access !== "invite") throw new Error("Pick who can book.");
  if (raw.capacityMode !== "bench" && raw.capacityMode !== "staff") throw new Error("Pick how capacity is counted.");
  const int = (v: number, lo: number, hi: number, what: string) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what} must be a whole number from ${lo} to ${hi}.`);
    return v;
  };
  const out: BookingTypeInput = {
    ...raw,
    name,
    description: raw.description.trim().slice(0, 500),
    durationMin: int(raw.durationMin, 5, 480, "Length (minutes)"),
    bufferMin: int(raw.bufferMin, 0, 240, "Buffer (minutes)"),
    slotStepMin: int(raw.slotStepMin, 5, 240, "Start times every (minutes)"),
    noticeMin: int(raw.noticeMin, 0, 60 * 24 * 30, "Minimum notice (minutes)"),
    horizonDays: int(raw.horizonDays, 1, 365, "Bookable up to (days ahead)"),
    benchCapacity: int(raw.benchCapacity, 1, 50, "Bookings at the same time"),
    createsWorkOrder: raw.location === "in_person" && raw.createsWorkOrder,
    // The directory is of showrooms; the online team's calls aren't listed in it.
    inDirectory: profileKind !== "online" && !!raw.inDirectory,
    useStoreHours: !!raw.useStoreHours,
    color: raw.color && isBookingColor(raw.color) ? raw.color : "orange",
    ...(raw.hostIds ? { hostIds: [...new Set(raw.hostIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))].slice(0, 6) } : {}),
  };
  if (!out.useStoreHours && !Object.keys(out.hours).length) throw new Error("Set the hours it can be booked on at least one day, or use the store's availability.");
  return out;
}

// ---- Database ---------------------------------------------------------------------------------

export async function listBookingTypes(dbx: DbOrTx, showroomId: string): Promise<BookingType[]> {
  return dbx.select().from(bookingTypes).where(eq(bookingTypes.showroomId, showroomId)).orderBy(asc(bookingTypes.sortOrder), asc(bookingTypes.name));
}

export async function getBookingType(dbx: DbOrTx, showroomId: string, id: string): Promise<BookingType> {
  const [row] = await dbx.select().from(bookingTypes).where(and(eq(bookingTypes.id, id), eq(bookingTypes.showroomId, showroomId)));
  if (!row) throw new Error("That booking type isn't in this store.");
  return row;
}

async function freeSlug(dbx: DbOrTx, showroomId: string, base: string, exceptId?: string): Promise<string> {
  const taken = new Set((await listBookingTypes(dbx, showroomId)).filter((t) => t.id !== exceptId).map((t) => t.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export async function createBookingType(dbx: DbOrTx, showroomId: string, input: BookingTypeInput): Promise<BookingType> {
  const existing = await listBookingTypes(dbx, showroomId);
  const slug = await freeSlug(dbx, showroomId, typeSlug(input.name));
  const sortOrder = Math.max(0, ...existing.map((t) => t.sortOrder)) + 1;
  const [row] = await dbx.insert(bookingTypes).values({ showroomId, slug, kind: "standard", sortOrder, ...input }).returning();
  return row;
}

export async function updateBookingType(dbx: DbOrTx, showroomId: string, id: string, input: BookingTypeInput): Promise<void> {
  const current = await getBookingType(dbx, showroomId, id);
  if (current.kind === "pickup") throw new Error("Bike pickup times come from Settings › Capacity.");
  const slug = current.name === input.name ? current.slug : await freeSlug(dbx, showroomId, typeSlug(input.name), id);
  await dbx.update(bookingTypes).set({ ...input, slug }).where(eq(bookingTypes.id, id));
}

/** The pickup type only takes a new name and description; its hours and capacity live in Settings › Capacity. */
export async function updatePickupType(dbx: DbOrTx, showroomId: string, id: string, patch: { name: string; description: string }): Promise<void> {
  const current = await getBookingType(dbx, showroomId, id);
  if (current.kind !== "pickup") throw new Error("Not the pickup type.");
  if (!patch.name.trim()) throw new Error("Give the booking type a name.");
  await dbx.update(bookingTypes).set({ name: patch.name.trim(), description: patch.description.trim().slice(0, 500) }).where(eq(bookingTypes.id, id));
}

export async function setBookingTypeActive(dbx: DbOrTx, showroomId: string, id: string, active: boolean): Promise<BookingType> {
  const current = await getBookingType(dbx, showroomId, id);
  await dbx.update(bookingTypes).set({ active }).where(eq(bookingTypes.id, id));
  return current;
}

/** Every physical store has a bike pickup type; created with the store (and by migration 0011 for existing ones). */
export async function ensurePickupType(dbx: DbOrTx, showroomId: string): Promise<void> {
  await dbx
    .insert(bookingTypes)
    .values({ showroomId, slug: "pickup", name: "Bike pickup", description: "Collect your new bike. Booked from the link we send when it arrives.", kind: "pickup", access: "invite", location: "in_person", noticeMin: 0, sortOrder: 0, color: "slate" })
    .onConflictDoNothing();
}

/**
 * The weekly hours a showroom's new types start with: the days and times it takes pickups (Settings ›
 * Capacity), the only opening hours Kickstand knows. Mon–Fri 8–4 when a store has none (and for the online team).
 */
export function hoursFromCapacity(rules: Pick<CapacityRule, "weekday" | "capacity" | "windowStart" | "windowEnd">[]): WeeklyHours {
  const out: WeeklyHours = {};
  for (const r of rules) if (r.capacity > 0) out[String(r.weekday)] = [[r.windowStart.slice(0, 5), r.windowEnd.slice(0, 5)]];
  return Object.keys(out).length ? out : WEEKDAY_8_TO_4;
}

/** The types every profile gets without anyone setting them up: the presets for its kind, all public and on. */
export function defaultTypes(kind: string, hours: WeeklyHours): (BookingTypeInput & { slug: string })[] {
  return presetsFor(kind).map((p) => ({
    slug: p.key,
    name: p.name,
    description: p.description,
    location: p.location,
    access: "public",
    durationMin: p.durationMin,
    bufferMin: NEW_TYPE_DEFAULTS.bufferMin,
    slotStepMin: NEW_TYPE_DEFAULTS.slotStepMin,
    noticeMin: NEW_TYPE_DEFAULTS.noticeMin,
    horizonDays: NEW_TYPE_DEFAULTS.horizonDays,
    capacityMode: "bench",
    benchCapacity: NEW_TYPE_DEFAULTS.benchCapacity,
    hours: kind === "online" ? WEEKDAY_8_TO_4 : hours,
    createsWorkOrder: p.createsWorkOrder,
    useStoreHours: true,
    color: p.color,
    // Calls with the online team ask what it's about, like the old YCBM form; services ask which bike.
    questions: kind === "online" ? SUGGESTED_CALL_QUESTIONS : p.createsWorkOrder ? SUGGESTED_SERVICE_QUESTIONS : [],
  }));
}

/**
 * The profile's availability ("Manage availability"), set up the first time it's needed: a showroom starts
 * from its pickup days and times, the online team from Mon–Fri 8–4. Returns the hours in force.
 */
export async function ensureStoreHours(dbx: DbOrTx, showroom: { id: string; kind: string }): Promise<WeeklyHours> {
  const [row] = await dbx.select({ hours: showrooms.bookingHours }).from(showrooms).where(eq(showrooms.id, showroom.id));
  if (row && Object.keys(row.hours ?? {}).length) return row.hours as WeeklyHours;
  const rules = showroom.kind === "online" ? [] : await dbx.select().from(capacityRules).where(eq(capacityRules.showroomId, showroom.id));
  const hours = hoursFromCapacity(rules);
  await dbx.update(showrooms).set({ bookingHours: hours }).where(eq(showrooms.id, showroom.id));
  return hours;
}

/** Save the profile's availability. Types following it change at once. */
export async function setStoreHours(dbx: DbOrTx, showroomId: string, hours: WeeklyHours): Promise<void> {
  if (!Object.keys(hours).length) throw new Error("Open at least one day. To stop online booking, switch the booking types off instead.");
  await dbx.update(showrooms).set({ bookingHours: hours }).where(eq(showrooms.id, showroomId));
}

/**
 * Give a profile its default booking types the first time it has none, so booking works out of the box
 * (Gord, 2026-11-13: "it should just be available"). Once a profile has any standard type — even one switched
 * off or renamed — nothing is added again, so staff changes stick. Safe to call on every page load.
 */
export async function ensureDefaultBookingTypes(dbx: DbOrTx, showroom: { id: string; kind: string }): Promise<void> {
  const [{ n }] = await dbx
    .select({ n: sql<number>`count(*)::int` })
    .from(bookingTypes)
    .where(and(eq(bookingTypes.showroomId, showroom.id), eq(bookingTypes.kind, "standard")));
  if (n > 0) return;
  const types = defaultTypes(showroom.kind, await ensureStoreHours(dbx, showroom));
  if (!types.length) return;
  await dbx
    .insert(bookingTypes)
    .values(types.map((t, i) => ({ ...t, showroomId: showroom.id, kind: "standard", sortOrder: i + 1 })))
    .onConflictDoNothing();
}

/**
 * A booking type in the all-showrooms directory is offered at every showroom: each store gets its own copy (so
 * its bookings, capacity, Lightspeed and calendar stay that store's), and saving any copy brings the others in
 * line. Shared: what the customer sees and the booking rules. Per store: on/off, hours, capacity, people shown,
 * Lightspeed work order. Copies are found by the slug the type had before this save (`previousSlug`), so a
 * rename carries over. Runs when the type is in the directory or was until now (unticking reaches every copy).
 * Returns the stores it couldn't give the new name to (another of their types already uses it).
 */
/**
 * `only`: the showrooms ticked under the directory switch. Others keep their copy (shared fields still synced) but
 * out of the directory, and get no new copy. Omitted = every showroom.
 */
export async function syncDirectoryCopies(dbx: DbOrTx, sourceId: string, previousSlug: string, only?: string[]): Promise<string[]> {
  const [src] = await dbx.select().from(bookingTypes).where(eq(bookingTypes.id, sourceId));
  if (!src || src.kind !== "standard") return [];
  const stores = await dbx.select({ id: showrooms.id, name: showrooms.name }).from(showrooms).where(eq(showrooms.kind, "showroom"));
  const shared = {
    name: src.name,
    slug: src.slug,
    description: src.description,
    location: src.location,
    access: src.access,
    durationMin: src.durationMin,
    bufferMin: src.bufferMin,
    slotStepMin: src.slotStepMin,
    noticeMin: src.noticeMin,
    horizonDays: src.horizonDays,
    questions: src.questions,
    color: src.color,
    inDirectory: src.inDirectory,
  };
  const skipped: string[] = [];
  for (const store of stores) {
    if (store.id === src.showroomId) continue;
    const theirs = await listBookingTypes(dbx, store.id);
    const copy = theirs.find((t) => t.kind === "standard" && (t.slug === previousSlug || t.slug === src.slug));
    const clash = theirs.find((t) => t.slug === src.slug && t.id !== copy?.id);
    if (clash) { skipped.push(store.name); continue; }
    const picked = !only || only.includes(store.id);
    if (copy) {
      await dbx.update(bookingTypes).set({ ...shared, inDirectory: shared.inDirectory && picked }).where(eq(bookingTypes.id, copy.id));
    } else if (src.inDirectory && picked) {
      await dbx.insert(bookingTypes).values({
        ...shared,
        showroomId: store.id,
        kind: "standard",
        capacityMode: src.capacityMode,
        benchCapacity: src.benchCapacity,
        hours: src.hours,
        useStoreHours: true,
        createsWorkOrder: src.createsWorkOrder,
        hostIds: [],
        sortOrder: Math.max(0, ...theirs.map((t) => t.sortOrder)) + 1,
      });
    }
  }
  return skipped;
}

/** Showroom ids whose copy of this type is in the directory (for ticking the editor's checklist). */
export async function directoryStoreIds(dbx: DbOrTx, slug: string): Promise<string[]> {
  const rows = await dbx
    .select({ id: bookingTypes.showroomId })
    .from(bookingTypes)
    .where(and(eq(bookingTypes.slug, slug), eq(bookingTypes.kind, "standard"), eq(bookingTypes.inDirectory, true)));
  return rows.map((r) => r.id);
}
