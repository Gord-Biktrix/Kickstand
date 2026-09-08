import { NextResponse, type NextRequest } from "next/server";
import { PASSWORD_NUDGE_COOKIE, getCurrentUser } from "@/lib/auth";

/** "Not now" on the set-a-password banner: remember for 90 days, go back where they were. */
export async function POST(request: NextRequest) {
  if (!(await getCurrentUser())) return NextResponse.redirect(new URL("/login", request.url));
  const back = request.headers.get("referer") ?? new URL("/app", request.url).toString();
  const res = NextResponse.redirect(back, 303);
  res.cookies.set(PASSWORD_NUDGE_COOKIE, "1", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 90 * 86_400 });
  return res;
}
