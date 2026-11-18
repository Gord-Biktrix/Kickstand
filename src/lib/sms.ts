/**
 * Kickstand Chat's text provider (docs/kickstand-chat.md). Like the Notifier: one interface, Twilio for real,
 * console when Twilio isn't configured (local dev never texts anyone), memory for tests. No Twilio SDK: the REST
 * call and the webhook signature are small enough to do by hand.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "./logger";

export { plainText, segmentCount } from "./sms-text";

export type OutgoingText = {
  from: string;
  to: string;
  body: string;
  mediaUrls?: string[];
  /** Where Twilio posts delivery updates. */
  statusCallback?: string;
};

export type SentText = { sid: string; status: string };

export class TextSendError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message);
  }
}

export interface TextSender {
  /** Hands the text to the provider. Throws TextSendError when it is refused. */
  send(text: OutgoingText): Promise<SentText>;
}

/** Twilio Messages API. https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource */
export class TwilioSender implements TextSender {
  constructor(
    private accountSid: string,
    private authToken: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async send(text: OutgoingText): Promise<SentText> {
    const form = new URLSearchParams({ From: text.from, To: text.to });
    if (text.body) form.set("Body", text.body);
    for (const url of text.mediaUrls ?? []) form.append("MediaUrl", url);
    if (text.statusCallback) form.set("StatusCallback", text.statusCallback);
    const res = await this.fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: twilioBasicAuth(this.accountSid, this.authToken), "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; code?: number; message?: string };
    if (!res.ok || !json.sid) throw new TextSendError(json.message ?? `Twilio ${res.status}`, json.code != null ? String(json.code) : null);
    return { sid: json.sid, status: json.status ?? "queued" };
  }
}

export class ConsoleSender implements TextSender {
  private n = 0;
  async send(text: OutgoingText): Promise<SentText> {
    logger.info({ from: text.from, to: text.to, chars: text.body.length, media: text.mediaUrls?.length ?? 0 }, "sms (console) send");
    return { sid: `SMconsole${Date.now()}${++this.n}`, status: "sent" };
  }
}

export class MemorySender implements TextSender {
  sent: OutgoingText[] = [];
  /** Error codes to throw on the next sends (Twilio's, e.g. "21610" for an opted-out number). */
  failNext: (string | null)[] = [];
  private n = 0;
  async send(text: OutgoingText): Promise<SentText> {
    if (this.failNext.length) {
      const code = this.failNext.shift() ?? null;
      throw new TextSendError(`simulated failure${code ? ` ${code}` : ""}`, code);
    }
    this.sent.push(text);
    return { sid: `SMtest${String(++this.n).padStart(6, "0")}`, status: "queued" };
  }
}

export function twilioBasicAuth(sid: string, token: string): string {
  return `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
}

export function twilioConfigured(): boolean {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

let override: TextSender | null = null;

export function setTextSender(s: TextSender | null) {
  override = s;
}

export function getTextSender(): TextSender {
  if (override) return override;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (sid && token) return new TwilioSender(sid, token);
  return new ConsoleSender();
}

/**
 * Twilio's webhook signature: base64 HMAC-SHA1, keyed with the auth token, of the full URL Twilio called followed by
 * every POST parameter as name + value, sorted by name. https://www.twilio.com/docs/usage/security#validating-requests
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string | string[]>): string {
  const data = Object.keys(params)
    .sort()
    .map((k) => {
      const v = params[k];
      return Array.isArray(v) ? v.map((x) => k + x).join("") : k + v;
    })
    .join("");
  return createHmac("sha1", authToken).update(url + data, "utf8").digest("base64");
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string | string[]>, signature: string | null): boolean {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Keywords carriers and Twilio treat as opt-out / opt-in / help (the whole message, any case). */
const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE", "STOP ALL"]);
const START_WORDS = new Set(["START", "YES", "UNSTOP", "OPTIN"]);
const HELP_WORDS = new Set(["HELP", "INFO"]);

export function optKeyword(body: string, optOutType?: string | null): "stop" | "start" | "help" | null {
  const t = (optOutType ?? "").toUpperCase();
  if (t === "STOP") return "stop";
  if (t === "START") return "start";
  if (t === "HELP") return "help";
  const w = body.trim().replace(/[.!]+$/, "").toUpperCase();
  if (STOP_WORDS.has(w)) return "stop";
  if (START_WORDS.has(w)) return "start";
  if (HELP_WORDS.has(w)) return "help";
  return null;
}
