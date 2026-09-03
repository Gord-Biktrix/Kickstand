import type { DbOrTx } from "@/db/client";
import { events } from "@/db/schema";

export type EventInput = {
  showroomId: string;
  unitId?: string | null;
  orderId?: string | null;
  appointmentId?: string | null;
  type: string;
  actor: string;
  payload?: Record<string, unknown>;
};

export async function logEvent(dbx: DbOrTx, e: EventInput): Promise<void> {
  await dbx.insert(events).values({
    showroomId: e.showroomId,
    unitId: e.unitId ?? null,
    orderId: e.orderId ?? null,
    appointmentId: e.appointmentId ?? null,
    type: e.type,
    actor: e.actor,
    payload: e.payload ?? {},
  });
}
