import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { bookingTypes, showrooms, type BookingType } from "@/db/schema";
import { effectiveHours, type WeeklyHours } from "./booking-types";
import { addLocalDays, formatInZone, timeToMinutes, toLocalDate, weekdayOf } from "./time";

/**
 * The all-showrooms directory (/book/all/<slug>): every store whose booking type with that slug is public, on and
 * switched into the directory. The customer picks a store first, then books on that store's own page.
 */

export type DirectoryStore = {
  slug: string;
  name: string;
  /** "Calgary" for "Biktrix Calgary". */
  city: string;
  addressLine: string;
  timezone: string;
  lat: number | null;
  lng: number | null;
  hours: WeeklyHours;
};

export type Directory = { type: BookingType; stores: DirectoryStore[] };

export async function loadDirectory(dbx: DbOrTx, typeSlug: string): Promise<Directory | null> {
  const rows = await dbx
    .select({ type: bookingTypes, store: showrooms })
    .from(bookingTypes)
    .innerJoin(showrooms, eq(showrooms.id, bookingTypes.showroomId))
    .where(and(eq(bookingTypes.slug, typeSlug), eq(bookingTypes.inDirectory, true), eq(bookingTypes.active, true), eq(bookingTypes.access, "public"), eq(bookingTypes.kind, "standard")))
    .orderBy(asc(showrooms.name));
  if (!rows.length) return null;
  return {
    type: rows[0].type,
    stores: rows.map(({ type, store }) => ({
      slug: store.slug,
      name: store.name,
      city: cityOf(store.name),
      addressLine: store.addressLine,
      timezone: store.timezone,
      lat: store.lat,
      lng: store.lng,
      hours: effectiveHours(type, store.bookingHours as WeeklyHours),
    })),
  };
}

export function cityOf(name: string): string {
  return name.replace(/^biktrix\s+/i, "").trim() || name;
}

/** Great-circle distance in km. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A store this close to the visitor gets "Closest to you". Farther than that, it's only sorted first. */
export const CLOSEST_KM = 400;

/**
 * Closest first when we know roughly where the visitor is (stores without a position go last), A–Z otherwise.
 * `closest` is the slug to mark, only when it's within CLOSEST_KM.
 */
export function orderStores<T extends Pick<DirectoryStore, "slug" | "city" | "lat" | "lng">>(stores: T[], visitor: { lat: number; lng: number } | null): { stores: T[]; closest: string | null } {
  const az = [...stores].sort((a, b) => a.city.localeCompare(b.city));
  if (!visitor) return { stores: az, closest: null };
  const dist = (s: T) => (s.lat == null || s.lng == null ? Infinity : distanceKm(visitor, { lat: s.lat, lng: s.lng }));
  const sorted = az.map((s) => ({ s, d: dist(s) })).sort((a, b) => a.d - b.d);
  return { stores: sorted.map((x) => x.s), closest: sorted[0] && sorted[0].d <= CLOSEST_KM ? sorted[0].s.slug : null };
}

/** The visitor's rough position from Vercel's request headers; null locally or when it's missing. */
export function visitorPosition(h: { get(name: string): string | null }): { lat: number; lng: number } | null {
  const lat = Number(h.get("x-vercel-ip-latitude"));
  const lng = Number(h.get("x-vercel-ip-longitude"));
  if (!h.get("x-vercel-ip-latitude") || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function clock(hhmm: string): string {
  const m = timeToMinutes(hhmm);
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${h % 12 || 12}${min ? `:${String(min).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Open now · until 5:15 pm", "Opens 10 am", "Opens Tue 10 am", or null when it has no hours at all. */
export function openLine(hours: WeeklyHours, tz: string, now: Date): { text: string; open: boolean } | null {
  const today = toLocalDate(now, tz);
  const nowMin = timeToMinutes(formatInZone(now, tz, "HH:mm"));
  const ranges = (hours[String(weekdayOf(today))] ?? []).map(([a, b]) => [timeToMinutes(a), timeToMinutes(b), a, b] as const).sort((x, y) => x[0] - y[0]);
  const on = ranges.find((r) => nowMin >= r[0] && nowMin < r[1]);
  if (on) return { text: `Open now · until ${clock(on[3])}`, open: true };
  const later = ranges.find((r) => r[0] > nowMin);
  if (later) return { text: `Opens ${clock(later[2])}`, open: false };
  for (let i = 1; i <= 7; i++) {
    const d = addLocalDays(today, i);
    const first = [...(hours[String(weekdayOf(d))] ?? [])].sort((x, y) => timeToMinutes(x[0]) - timeToMinutes(y[0]))[0];
    if (first) return { text: `Opens ${i === 1 ? "tomorrow" : DAY[weekdayOf(d)]} ${clock(first[0])}`, open: false };
  }
  return null;
}
