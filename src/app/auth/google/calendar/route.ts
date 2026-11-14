import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { calendarAuthUrl, calendarConnectEnabled } from "@/lib/google-connection";
import { generateToken } from "@/lib/tokens";

export const CAL_STATE_COOKIE = "ks_gcal_state";
const STORES = "/app/settings/stores";

/** Settings › Stores › Connect Google Calendar: admins only; random state in a short-lived cookie, then Google. */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !hasRole(user.role, "admin")) return NextResponse.redirect(new URL("/app", request.url));
  if (!calendarConnectEnabled()) return NextResponse.redirect(new URL(`${STORES}?error=${encodeURIComponent("Google sign-in isn't set up on the server.")}`, request.url));
  const state = generateToken();
  const res = NextResponse.redirect(calendarAuthUrl(state));
  res.cookies.set(CAL_STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600 });
  return res;
}
