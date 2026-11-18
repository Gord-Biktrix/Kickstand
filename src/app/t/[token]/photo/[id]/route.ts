import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db/client";
import { findings, ticketPhotos } from "@/db/schema";
import { trackerByToken } from "@/lib/tracker";

/** A photo on the customer's tracker: only photos of findings already sent to them for this work order. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  const tracker = await trackerByToken(db, token);
  if (!tracker || !/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const sent = await db.select({ photoIds: findings.photoIds }).from(findings).where(and(eq(findings.workorderId, tracker.workorderId), isNotNull(findings.requestId)));
  if (!sent.some((f) => f.photoIds.includes(id))) return new Response("Not found", { status: 404 });
  const [row] = await db.select({ image: ticketPhotos.image }).from(ticketPhotos).where(eq(ticketPhotos.id, id));
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(row.image, "base64"), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" } });
}
