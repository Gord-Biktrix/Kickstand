import { NextResponse, type NextRequest } from "next/server";
import { googleAuthUrl, googleEnabled } from "@/lib/google-auth";
import { generateToken } from "@/lib/tokens";

export const STATE_COOKIE = "ks_oauth_state";

/** Start Sign in with Google: random state in a short-lived cookie, then off to Google's account chooser. */
export async function GET(request: NextRequest) {
  if (!googleEnabled()) return NextResponse.redirect(new URL("/login?error=google_off", request.url));
  const state = generateToken();
  const res = NextResponse.redirect(googleAuthUrl(state));
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  return res;
}
