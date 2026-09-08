import { NextResponse, type NextRequest } from "next/server";
import { createSessionForEmail, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { exchangeGoogleCode, googleEnabled } from "@/lib/google-auth";
import { logger } from "@/lib/logger";
import { STATE_COOKIE } from "../route";

/** Google sends the person back here. Verify state + token, then only active staff get a session. */
export async function GET(request: NextRequest) {
  const fail = (error: string) => {
    const res = NextResponse.redirect(new URL(`/login?error=${error}`, request.url));
    res.cookies.delete(STATE_COOKIE);
    return res;
  };
  if (!googleEnabled()) return fail("google_off");
  const q = request.nextUrl.searchParams;
  const code = q.get("code");
  const state = q.get("state");
  const expected = request.cookies.get(STATE_COOKIE)?.value;
  if (!code || !state || !expected || state !== expected) return fail("google");
  const identity = await exchangeGoogleCode(code);
  if (!identity.ok) return fail(identity.reason === "domain" ? "domain" : "google");
  const session = await createSessionForEmail(identity.email);
  if (!session) {
    logger.info({ emailDomain: identity.email.split("@")[1] }, "google sign-in refused: not on staff list");
    return fail("not_staff");
  }
  const res = NextResponse.redirect(new URL("/app", request.url));
  res.cookies.delete(STATE_COOKIE);
  res.cookies.set(SESSION_COOKIE, session, sessionCookieOptions());
  return res;
}
