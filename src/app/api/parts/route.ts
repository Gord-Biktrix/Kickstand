import type { NextRequest } from "next/server";
import { db } from "@/db/client";
import { getCurrentUser } from "@/lib/auth";
import { currentShowroom } from "@/lib/current-showroom";
import { LightspeedClient, lightspeedEnabled } from "@/lib/lightspeed";
import { searchParts } from "@/lib/tickets";
import { lightspeedReason } from "@/lib/workorder-lines";

/** Parts tab on New ticket: Lightspeed items for the chosen bike, or matching what's typed. Staff only, read only. */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Sign in again." }, { status: 401 });
  const showroom = await currentShowroom(user);
  if (!lightspeedEnabled(showroom)) return Response.json({ parts: [], error: "Lightspeed isn't switched on for this store." });
  const p = request.nextUrl.searchParams;
  try {
    const parts = await searchParts(new LightspeedClient(db), { q: p.get("q") ?? "", bike: p.get("bike") ?? "" });
    return Response.json({ parts }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ parts: [], error: lightspeedReason(err) });
  }
}
