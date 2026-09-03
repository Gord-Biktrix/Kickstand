import { NextResponse, type NextRequest } from "next/server";
import { consumeMagicLink, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const session = token ? await consumeMagicLink(token) : null;
  if (!session) return NextResponse.redirect(new URL("/login?error=invalid", request.url));
  const res = NextResponse.redirect(new URL("/app", request.url));
  res.cookies.set(SESSION_COOKIE, session, sessionCookieOptions());
  return res;
}
