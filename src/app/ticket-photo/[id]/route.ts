import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { ticketPhotos } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";

/** A New ticket photo. Staff only (it's a customer's bike, sometimes their home address in the background). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in", { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const [row] = await db.select({ image: ticketPhotos.image }).from(ticketPhotos).where(eq(ticketPhotos.id, id));
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(row.image, "base64"), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" } });
}
