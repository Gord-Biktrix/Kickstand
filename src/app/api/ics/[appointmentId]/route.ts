import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { appointments, units } from "@/db/schema";
import { buildIcs } from "@/lib/ics";
import { getShowroomById } from "@/lib/showroom";

export async function GET(_request: Request, { params }: { params: Promise<{ appointmentId: string }> }) {
  const { appointmentId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(appointmentId)) return new Response("Not found", { status: 404 });
  const [row] = await db
    .select({ appointment: appointments, unit: units })
    .from(appointments)
    .innerJoin(units, eq(units.id, appointments.unitId))
    .where(eq(appointments.id, appointmentId))
    .limit(1);
  if (!row) return new Response("Not found", { status: 404 });
  const showroom = await getShowroomById(db, row.appointment.showroomId);
  const ics = buildIcs({
    uid: row.appointment.id,
    startsAt: row.appointment.startsAt,
    endsAt: row.appointment.endsAt,
    summary: `Bike pickup — ${row.unit.model}`,
    description: `Pickup and handover at ${showroom.name}. Bring photo ID and your helmet.`,
    location: showroom.addressLine,
  });
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="biktrix-pickup.ics"`,
      "Cache-Control": "private, no-store",
    },
  });
}
