import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { chatMessages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { twilioBasicAuth } from "@/lib/sms";

/** A customer's photo, fetched from Twilio with the account's credentials (Twilio media isn't public). Staff only. */
export async function GET(_request: Request, { params }: { params: Promise<{ message: string; n: string }> }) {
  if (!(await getCurrentUser())) return new Response("Sign in required", { status: 401 });
  const { message, n } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(message)) return new Response("Not found", { status: 404 });
  const [msg] = await db.select({ media: chatMessages.media }).from(chatMessages).where(eq(chatMessages.id, message));
  const item = msg?.media[Number(n)];
  if (!item) return new Response("Not found", { status: 404 });
  const url = new URL(item.url);
  if (url.protocol !== "https:" || url.hostname !== "api.twilio.com") return new Response("Not found", { status: 404 });
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return new Response("Texting isn't set up", { status: 503 });
  const res = await fetch(url, { headers: { Authorization: twilioBasicAuth(sid, token) }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok || !res.body) return new Response("Photo unavailable", { status: 502 });
  return new Response(res.body, { headers: { "Content-Type": res.headers.get("content-type") ?? item.contentType, "Cache-Control": "private, max-age=86400" } });
}
