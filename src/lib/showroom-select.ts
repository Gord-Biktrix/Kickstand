/**
 * Pure showroom selection (no Next.js imports — unit-testable). See current-showroom.ts for the
 * request-bound wrapper that reads the cookie and the signed-in user.
 */
import type { DbOrTx } from "@/db/client";
import type { StaffUser } from "@/db/schema";
import { hasRole } from "./roles";
import { listShowrooms, type ShowroomCtx } from "./showroom";

export const SHOWROOM_COOKIE = "ks_showroom";

export type UserLike = Pick<StaffUser, "role" | "showroomId"> | null;

/** Anyone signed in may *look at* any store (Gord: "view access only"). Editing is a separate question — see canEditShowroom. */
export function canSwitchShowroom(user: UserLike): boolean {
  return !!user;
}

/**
 * Admins edit everywhere. Managers and staff edit only their home store; another store is view-only.
 * An account with no home store is treated as at home everywhere (legacy single-store accounts).
 */
export function canEditShowroom(user: UserLike, showroom: Pick<ShowroomCtx, "id">): boolean {
  if (!user) return false;
  if (hasRole(user.role, "admin")) return true;
  return !user.showroomId || user.showroomId === showroom.id;
}

/** Why the current store is read-only for this user, or null when they may edit it. */
export function readOnlyReason(user: UserLike, showroom: Pick<ShowroomCtx, "id" | "name">, home: Pick<ShowroomCtx, "name" | "slug"> | null): string | null {
  if (canEditShowroom(user, showroom)) return null;
  return `You're viewing ${showroom.name} (view only). Switch back to ${home?.name ?? "your store"} to make changes.`;
}

/**
 * The store to show: the cookie's slug when it names a real store, else the user's home
 * (staff_users.showroom_id), else the default.
 */
export function pickShowroom(all: ShowroomCtx[], user: UserLike, cookieSlug: string | null | undefined, defaultSlug: string): ShowroomCtx {
  if (all.length === 0) throw new Error("No showrooms — run the seed");
  const home = user?.showroomId ? all.find((s) => s.id === user.showroomId) ?? null : null;
  const fallback = home ?? all.find((s) => s.slug === defaultSlug) ?? all[0];
  if (!canSwitchShowroom(user)) return fallback;
  const fromCookie = cookieSlug ? all.find((s) => s.slug === cookieSlug) ?? null : null;
  return fromCookie ?? fallback;
}

/** The showroom whose Lightspeed shop id matches the button's `shopID`, or null when no store is live there yet. */
export async function showroomForLightspeedShop(dbx: DbOrTx, shopID: string | number): Promise<ShowroomCtx | null> {
  const n = Number(shopID);
  if (!Number.isFinite(n)) return null;
  const all = await listShowrooms(dbx);
  return all.find((s) => s.settings.lightspeed.shop_id === n) ?? null;
}

/**
 * Where a store switch should land. Detail pages (a bike, an order, a customer) belong to one store,
 * so keeping the path after switching would 404; `recordInTarget` says whether the record also exists
 * in the store being switched to. When it doesn't, fall back to that section's list page. Anything
 * else (lists, settings, the schedule) is the same page in every store and is kept as-is.
 */
export function landingAfterSwitch(nextPath: string, recordInTarget: boolean): string {
  const m = /^\/app\/(units|orders|customers)\/[^/?#]+/.exec(nextPath);
  if (!m || recordInTarget) return nextPath;
  return m[1] === "customers" ? "/app/search" : "/app/bikes";
}

/** The detail record a path points at, if any — used by /app/switch to check it exists in the new store. */
export function detailTarget(nextPath: string): { kind: "unit" | "order" | "customer"; id: string } | null {
  const m = /^\/app\/(units|orders|customers)\/([^/?#]+)/.exec(nextPath);
  if (!m) return null;
  const kind = m[1] === "units" ? "unit" : m[1] === "orders" ? "order" : "customer";
  return { kind, id: decodeURIComponent(m[2]) };
}
