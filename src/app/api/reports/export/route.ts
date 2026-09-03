import type { NextRequest } from "next/server";
import { db } from "@/db/client";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { exportRows } from "@/lib/queries";
import { getShowroom } from "@/lib/showroom";

function csv(rows: (string | number | null | undefined)[][]): string {
  return rows
    .map((r) => r.map((v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(","))
    .join("\n");
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !hasRole(user.role, "admin")) return new Response("Forbidden", { status: 403 });
  const type = request.nextUrl.searchParams.get("type") ?? "units";
  const showroom = await getShowroom(db);
  const { unitRows, apptRows } = await exportRows(db, showroom);
  let body: string;
  if (type === "appointments") {
    body = csv([
      ["appointment_id", "unit_id", "on_date", "starts_at", "ends_at", "status", "cancelled_reason", "replaced_by", "created_by", "created_at"],
      ...apptRows.map((a) => [a.id, a.unitId, a.onDate, a.startsAt.toISOString(), a.endsAt.toISOString(), a.status, a.cancelledReason, a.replacedBy, a.createdBy, a.createdAt.toISOString()]),
    ]);
  } else {
    body = csv([
      ["unit_id", "box_tag", "order_ref", "source", "customer_name", "model", "size", "colour", "status", "received_at", "invited_at", "book_by", "pickup_by", "picked_up_at", "extension_count", "no_show_count", "storage_from", "storage_collected_cents", "storage_waived_cents", "early_bird", "terms_version"],
      ...unitRows.map(({ unit: u, order: o }) => [u.id, u.boxTag, o?.orderRef, o?.source, o?.customerName, u.model, u.size, u.colour, u.status, u.receivedAt.toISOString(), u.invitedAt?.toISOString(), u.bookBy?.toISOString(), u.pickupBy?.toISOString(), u.pickedUpAt?.toISOString(), u.extensionCount, u.noShowCount, u.storageFrom?.toISOString(), u.storageCollectedCents, u.storageWaivedCents, u.earlyBird ? 1 : 0, o?.termsVersion]),
    ]);
  }
  return new Response(body, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${type}.csv"` },
  });
}
