/**
 * Staff photos for booking pages: each booking type can show the people a customer might talk to ("hosts",
 * booking_types.host_ids), with their photo and first name above the title. Photos are small square JPEGs
 * (resized in the browser before upload), stored as base64 and served from /staff-photo/<id>.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { staffPhotos, staffUsers } from "@/db/schema";

const MAX_BASE64 = 200_000; // ~150 KB of JPEG; a 256px photo is usually 15–30 KB.

/** Accepts the data URL the upload button makes (data:image/jpeg;base64,…). Throws a plain sentence. */
export function photoFromDataUrl(dataUrl: string): string {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) throw new Error("That photo couldn't be read. Try a JPEG or PNG.");
  if (m[1].length > MAX_BASE64) throw new Error("That photo is too large. Try a smaller one.");
  return m[1];
}

export async function setStaffPhoto(dbx: DbOrTx, staffUserId: string, base64: string): Promise<void> {
  await dbx
    .insert(staffPhotos)
    .values({ staffUserId, image: base64 })
    .onConflictDoUpdate({ target: staffPhotos.staffUserId, set: { image: base64, updatedAt: new Date() } });
}

export async function removeStaffPhoto(dbx: DbOrTx, staffUserId: string): Promise<void> {
  await dbx.delete(staffPhotos).where(eq(staffPhotos.staffUserId, staffUserId));
}

export async function getStaffPhoto(dbx: DbOrTx, staffUserId: string): Promise<{ image: string; updatedAt: Date } | null> {
  const [row] = await dbx.select({ image: staffPhotos.image, updatedAt: staffPhotos.updatedAt }).from(staffPhotos).where(eq(staffPhotos.staffUserId, staffUserId));
  return row ?? null;
}

/** Photo URLs (with a version so a new photo isn't served from cache) for staff who have one. */
export async function photoUrls(dbx: DbOrTx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await dbx.select({ id: staffPhotos.staffUserId, updatedAt: staffPhotos.updatedAt }).from(staffPhotos).where(inArray(staffPhotos.staffUserId, ids));
  return new Map(rows.map((r) => [r.id, `/staff-photo/${r.id}?v=${r.updatedAt.getTime()}`]));
}

export type Host = { id: string; name: string; photo: string | null };

/** The people a booking page shows, in the type's order: active staff only, first names only (it's public). */
export async function hostsFor(dbx: DbOrTx, hostIds: string[]): Promise<Host[]> {
  if (hostIds.length === 0) return [];
  const people = await dbx.select({ id: staffUsers.id, name: staffUsers.name }).from(staffUsers).where(and(inArray(staffUsers.id, hostIds), eq(staffUsers.active, true)));
  const photos = await photoUrls(dbx, people.map((p) => p.id));
  const byId = new Map(people.map((p) => [p.id, p]));
  return hostIds.flatMap((id) => {
    const p = byId.get(id);
    return p ? [{ id, name: p.name.trim().split(/\s+/)[0] || p.name, photo: photos.get(id) ?? null }] : [];
  });
}

/** "Gord", "Gord and Sam", "Gord, Sam and Priya". */
export function hostNames(hosts: Pick<Host, "name">[]): string {
  const n = hosts.map((h) => h.name);
  return n.length <= 2 ? n.join(" and ") : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
}
