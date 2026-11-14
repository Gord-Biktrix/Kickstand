import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { exchangeCalendarCode, saveGoogleConnection } from "@/lib/google-connection";
import { logger } from "@/lib/logger";
import { CAL_STATE_COOKIE } from "../route";

const STORES = "/app/settings/stores";

/** Google sends the admin back here: check state and the account, then keep the connection. */
export async function GET(request: NextRequest) {
  const back = (q: string) => {
    const res = NextResponse.redirect(new URL(`${STORES}?${q}`, request.url));
    res.cookies.delete(CAL_STATE_COOKIE);
    return res;
  };
  const user = await getCurrentUser();
  if (!user || !hasRole(user.role, "admin")) return back(`error=${encodeURIComponent("Only admins can connect Google Calendar.")}`);
  const q = request.nextUrl.searchParams;
  if (q.get("error")) return back(`error=${encodeURIComponent("Google Calendar wasn't connected.")}`);
  const code = q.get("code");
  const state = q.get("state");
  const expected = request.cookies.get(CAL_STATE_COOKIE)?.value;
  if (!code || !state || !expected || state !== expected) return back(`error=${encodeURIComponent("That sign-in expired. Please connect again.")}`);
  const grant = await exchangeCalendarCode(code);
  if (!grant.ok) return back(`error=${encodeURIComponent(grant.reason)}`);
  await saveGoogleConnection(db, { email: grant.email, refreshToken: grant.refreshToken, scope: grant.scope, connectedBy: user.id });
  logger.info({ by: user.id }, "google calendar connected");
  return back(`ok=${encodeURIComponent(`Google Calendar connected as ${grant.email}. Pick each store's calendar below.`)}`);
}
