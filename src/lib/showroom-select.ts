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

/** Store access is by role: admins see every store and may switch; managers and staff are pinned to their home store. */
export function canSwitchShowroom(user: UserLike): boolean {
  return !!user && hasRole(user.role, "admin");
}

/**
 * 1. Managers and staff: their home showroom (staff_users.showroom_id); the default when none is set.
 * 2. Admins: the cookie's slug when it names a real showroom, else their home, else the default.
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
