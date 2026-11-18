import { db } from "@/db/client";
import { photoByToken } from "@/lib/chat";

/** A photo staff texted: Twilio (and the customer's phone) fetch it from here. The token is the only key. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const photo = await photoByToken(db, token);
  if (!photo) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(photo.image, "base64"), { headers: { "Content-Type": photo.contentType, "Cache-Control": "private, max-age=86400" } });
}
