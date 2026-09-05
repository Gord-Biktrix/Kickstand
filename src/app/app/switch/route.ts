import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { getCurrentUser } from "@/lib/auth";
import { canSwitchShowroom, SHOWROOM_COOKIE } from "@/lib/current-showroom";
import { listShowrooms } from "@/lib/showroom";

/**
 * GET /app/switch?showroom=<slug>&next=<path> — remember the chosen showroom in a cookie and go on.
 * Used by the header switcher and by /app/book when the Lightspeed button's shopID belongs to another store.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const url = req.nextUrl;
  const slug = url.searchParams.get("showroom") ?? "";
  const nextPath = url.searchParams.get("next") ?? "/app";
  const safeNext = nextPath.startsWith("/app") && !nextPath.startsWith("//") ? nextPath : "/app";
  if (!user) return NextResponse.redirect(new URL("/login", url));
  const target = (await listShowrooms(db)).find((s) => s.slug === slug);
  if (!target) return NextResponse.redirect(new URL("/app?error=" + encodeURIComponent("Unknown showroom."), url));
  if (!canSwitchShowroom(user) && user.showroomId !== target.id) {
    return NextResponse.redirect(new URL("/app?error=" + encodeURIComponent(`Your account is for one store. Ask an admin to move it to ${target.name}.`), url));
  }
  const res = NextResponse.redirect(new URL(safeNext, url));
  res.cookies.set(SHOWROOM_COOKIE, target.slug, { path: "/app", httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 60 * 60 * 24 * 365 });
  return res;
}
