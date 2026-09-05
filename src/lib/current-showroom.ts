/**
 * Which showroom is "current" for a staff request. SPEC scopes the UI to one showroom by config;
 * this makes it per request instead — see pickShowroom in showroom-select.ts for the rules. The
 * Lightspeed Custom Button appends `shopID`; showroomForLightspeedShop maps it to the showroom whose
 * settings.lightspeed.shop_id matches, so one button URL serves every store.
 */
import { cookies } from "next/headers";
import { db } from "@/db/client";
import { getCurrentUser } from "./auth";
import { listShowrooms, type ShowroomCtx } from "./showroom";
import { pickShowroom, SHOWROOM_COOKIE, type UserLike } from "./showroom-select";

export { canSwitchShowroom, pickShowroom, SHOWROOM_COOKIE, showroomForLightspeedShop } from "./showroom-select";

export async function currentShowroom(user?: UserLike): Promise<ShowroomCtx> {
  const [all, jar, u] = await Promise.all([listShowrooms(db), cookies(), user === undefined ? getCurrentUser() : Promise.resolve(user)]);
  return pickShowroom(all, u, jar.get(SHOWROOM_COOKIE)?.value, process.env.DEFAULT_SHOWROOM ?? "vancouver");
}
