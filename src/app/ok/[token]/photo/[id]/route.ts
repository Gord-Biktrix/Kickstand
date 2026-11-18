import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { ticketPhotos } from "@/db/schema";
import { requestByToken } from "@/lib/findings";

/** A finding's photo, for the customer's link: only photos attached to that link's findings. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  const found = await requestByToken(db, token);
  if (!found || !found.findings.some((f) => f.photoIds.includes(id))) return new Response("Not found", { status: 404 });
  const [row] = await db.select({ image: ticketPhotos.image }).from(ticketPhotos).where(eq(ticketPhotos.id, id));
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(row.image, "base64"), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" } });
}
