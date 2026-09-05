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

/** Managers and admins, and anyone without a home showroom, may switch. Plain staff with a home are pinned. */
export function canSwitchShowroom(user: UserLike): boolean {
  if (!user) return false;
  return user.showroomId === null || hasRole(user.role, "manager");
}

/**
 * 1. Plain staff with a home showroom are pinned to it.
 * 2. Otherwise the cookie's slug, when it names a real showroom.
 * 3. Otherwise the user's home showroom, else the default slug, else the first showroom.
 */
export function pickShowroom(all: ShowroomCtx[], user: UserLike, cookieSlug: string | null | undefined, defaultSlug: string): ShowroomCtx {
  if (all.length === 0) throw new Error("No showrooms — run the seed");
  const home = user?.showroomId ? all.find((s) => s.id === user.showroomId) ?? null : null;
  if (home && !canSwitchShowroom(user)) return home;
  const fromCookie = cookieSlug ? all.find((s) => s.slug === cookieSlug) ?? null : null;
  return fromCookie ?? home ?? all.find((s) => s.slug === defaultSlug) ?? all[0];
}

/** The showroom whose Lightspeed shop id matches the button's `shopID`, or null when no store is live there yet. */
export async function showroomForLightspeedShop(dbx: DbOrTx, shopID: string | number): Promise<ShowroomCtx | null> {
  const n = Number(shopID);
  if (!Number.isFinite(n)) return null;
  const all = await listShowrooms(dbx);
  return all.find((s) => s.settings.lightspeed.shop_id === n) ?? null;
}
