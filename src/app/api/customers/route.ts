import type { NextRequest } from "next/server";
import { db } from "@/db/client";
import { getCurrentUser } from "@/lib/auth";
import { currentShowroom } from "@/lib/current-showroom";
import { LightspeedClient, lightspeedEnabled } from "@/lib/lightspeed";
import { searchCustomers } from "@/lib/tickets";

/** Type-ahead for the New ticket customer box: Kickstand's customers plus a Lightspeed name search. Staff only. */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Sign in again." }, { status: 401 });
  const q = request.nextUrl.searchParams.get("q") ?? "";
  const showroom = await currentShowroom(user);
  const result = await searchCustomers(db, q, lightspeedEnabled(showroom) ? new LightspeedClient(db) : undefined);
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
