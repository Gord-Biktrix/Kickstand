import { db } from "@/db/client";
import { getStaffPhoto } from "@/lib/staff-photos";

/** A staff member's booking-page photo. Public (it's shown on public booking pages); cached, versioned by ?v=. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const photo = await getStaffPhoto(db, id);
  if (!photo) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(photo.image, "base64"), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400, s-maxage=604800", "Access-Control-Allow-Origin": "*" },
  });
}
