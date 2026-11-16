import type { NextRequest } from "next/server";
import { db } from "@/db/client";
import { getCurrentUser } from "@/lib/auth";
import { currentShowroom } from "@/lib/current-showroom";
import { LightspeedClient, lightspeedEnabled } from "@/lib/lightspeed";
import { customerBikesWithStatus } from "@/lib/tickets";

/** The picked customer's bikes, for the New ticket bike buttons. Staff only. */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Sign in again." }, { status: 401 });
  const p = request.nextUrl.searchParams;
  const showroom = await currentShowroom(user);
  const result = await customerBikesWithStatus(db, { lsCustomerId: p.get("ls") || null, phone: p.get("phone") || null, email: p.get("email") || null }, lightspeedEnabled(showroom) ? new LightspeedClient(db) : undefined);
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
