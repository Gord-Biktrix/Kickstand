/**
 * Twilio's webhooks (inbound texts, delivery updates): form posts signed with the account's auth token. The
 * signature covers the exact URL Twilio called, which behind Vercel's proxy is best rebuilt from the forwarded host
 * (or APP_BASE_URL), so both are tried.
 */
import type { Db } from "@/db/client";
import { applyStatus, receiveText } from "./chat";
import { logger } from "./logger";
import { baseUrl } from "./messages";
import { verifyTwilioSignature } from "./sms";

export function candidateUrls(request: Request): string[] {
  const u = new URL(request.url);
  const path = u.pathname + u.search;
  const urls = new Set<string>([request.url]);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "");
  if (host) urls.add(`${proto}://${host}${path}`);
  urls.add(`${baseUrl()}${path}`);
  return [...urls];
}

export async function readSignedForm(request: Request, authToken: string | undefined): Promise<Record<string, string> | null> {
  if (!authToken) return null;
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") params[k] = v;
  const signature = request.headers.get("x-twilio-signature");
  return candidateUrls(request).some((url) => verifyTwilioSignature(authToken, url, params, signature)) ? params : null;
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export async function handleTwilioWebhook(db: Db, request: Request, kind: "inbound" | "status", authToken = process.env.TWILIO_AUTH_TOKEN): Promise<Response> {
  if (!authToken) return new Response("Texting isn't set up", { status: 503 });
  const params = await readSignedForm(request, authToken);
  if (!params) {
    logger.warn({ kind }, "twilio webhook: bad signature");
    return new Response("Bad signature", { status: 403 });
  }
  if (kind === "status") {
    await applyStatus(db, params);
    return new Response(null, { status: 204 });
  }
  const result = await receiveText(db, params);
  if (!result.ok && result.reason === "bad_request") return new Response("Bad request", { status: 400 });
  // An empty reply: Twilio itself answers STOP/HELP (Advanced Opt-Out), staff answer the rest from Kickstand.
  return new Response(EMPTY_TWIML, { status: 200, headers: { "Content-Type": "text/xml" } });
}
