import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { orders, units } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { customerProfile } from "@/lib/customers";
import { SHOWROOM_COOKIE } from "@/lib/current-showroom";
import { detailTarget, landingAfterSwitch } from "@/lib/showroom-select";
import { listShowrooms, type ShowroomCtx } from "@/lib/showroom";

/**
 * GET /app/switch?showroom=<slug>&next=<path> — remember the chosen showroom in a cookie and go on.
 * Used by the header switcher and by /app/book when the Lightspeed button's shopID belongs to another store.
 * A detail page (bike, order, customer) is kept only when that record exists in the new store;
 * otherwise we land on its list so the switch never ends in a 404.
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
  const landing = landingAfterSwitch(safeNext, await recordInStore(safeNext, target));
  const res = NextResponse.redirect(new URL(landing, url));
  res.cookies.set(SHOWROOM_COOKIE, target.slug, { path: "/app", httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 60 * 60 * 24 * 365 });
  return res;
}

async function recordInStore(path: string, showroom: ShowroomCtx): Promise<boolean> {
  const t = detailTarget(path);
  if (!t) return true;
  // Ids are uuids; a malformed one would make Postgres throw, so treat it as "not here".
  if (t.kind !== "customer" && !/^[0-9a-f-]{36}$/i.test(t.id)) return false;
  if (t.kind === "unit") {
    const [row] = await db.select({ id: units.id }).from(units).where(and(eq(units.id, t.id), eq(units.showroomId, showroom.id))).limit(1);
    return !!row;
  }
  if (t.kind === "order") {
    const [row] = await db.select({ id: orders.id }).from(orders).where(and(eq(orders.id, t.id), eq(orders.showroomId, showroom.id))).limit(1);
    return !!row;
  }
  return (await customerProfile(db, showroom, t.id)) !== null;
}
