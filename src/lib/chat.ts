/**
 * Kickstand Chat (docs/kickstand-chat.md): conversations between a store's texting number and a customer's phone.
 * Inbound texts and delivery updates arrive from Twilio's webhooks (app/api/twilio/*); staff replies go out through
 * lib/sms.ts. Nothing is sent unless the store's chat line is switched on.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { bookings, chatConversations, chatLines, chatMessages, chatPhotos, orders, type ChatConversation, type ChatLine, type ChatMedia, type ChatMessage } from "@/db/schema";
import { logger } from "./logger";
import { baseUrl } from "./messages";
import { normalizePhone } from "./phone";
import { getTextSender, optKeyword, plainText, segmentCount, TextSendError, type TextSender } from "./sms";
import { generateToken } from "./tokens";

export class ChatError extends Error {}

/** Twilio: "Attempt to send to unsubscribed recipient" (the customer texted STOP). */
export const OPTED_OUT_CODE = "21610";
export const MAX_BODY = 1600;

export async function getLine(db: Db, showroomId: string): Promise<ChatLine | null> {
  const [line] = await db.select().from(chatLines).where(eq(chatLines.showroomId, showroomId));
  return line ?? null;
}

export async function saveLine(db: Db, showroomId: string, patch: { number?: string | null; enabled?: boolean; numberState?: ChatLine["numberState"] }): Promise<ChatLine> {
  const number = patch.number === undefined ? undefined : patch.number === null || patch.number.trim() === "" ? null : normalizePhone(patch.number);
  if (patch.number && !number) throw new ChatError("That isn't a phone number.");
  const values = { ...(number !== undefined ? { number } : {}), ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), ...(patch.numberState ? { numberState: patch.numberState } : {}) };
  const [line] = await db
    .insert(chatLines)
    .values({ showroomId, ...values })
    .onConflictDoUpdate({ target: chatLines.showroomId, set: { ...values, updatedAt: new Date() } })
    .returning();
  return line;
}

async function lineForNumber(db: Db, number: string): Promise<ChatLine | null> {
  const [line] = await db.select().from(chatLines).where(eq(chatLines.number, number));
  return line ?? null;
}

/** The name Kickstand already knows for this phone in this store (latest order, else latest booking). */
export async function nameForPhone(db: Db, showroomId: string, phone: string): Promise<string | null> {
  const last10 = phone.replace(/\D/g, "").slice(-10);
  const [o] = await db
    .select({ name: orders.customerName })
    .from(orders)
    .where(and(eq(orders.showroomId, showroomId), sql`right(regexp_replace(coalesce(${orders.customerPhone}, ''), '\\D', '', 'g'), 10) = ${last10}`))
    .orderBy(desc(orders.updatedAt))
    .limit(1);
  if (o?.name) return o.name;
  const [b] = await db
    .select({ name: bookings.customerName })
    .from(bookings)
    .where(and(eq(bookings.showroomId, showroomId), sql`right(regexp_replace(coalesce(${bookings.customerPhone}, ''), '\\D', '', 'g'), 10) = ${last10}`))
    .orderBy(desc(bookings.updatedAt))
    .limit(1);
  return b?.name ?? null;
}

/** The conversation for this store and phone, made on first contact. */
export async function conversationFor(db: Db, showroomId: string, rawPhone: string, name?: string | null): Promise<ChatConversation> {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new ChatError("That isn't a phone number.");
  const [found] = await db.select().from(chatConversations).where(and(eq(chatConversations.showroomId, showroomId), eq(chatConversations.phone, phone)));
  if (found) {
    if (!found.name && name) {
      const [named] = await db.update(chatConversations).set({ name }).where(eq(chatConversations.id, found.id)).returning();
      return named;
    }
    return found;
  }
  const known = name ?? (await nameForPhone(db, showroomId, phone));
  const [made] = await db
    .insert(chatConversations)
    .values({ showroomId, phone, name: known, lastPreview: "" })
    .onConflictDoNothing({ target: [chatConversations.showroomId, chatConversations.phone] })
    .returning();
  if (made) return made;
  const [again] = await db.select().from(chatConversations).where(and(eq(chatConversations.showroomId, showroomId), eq(chatConversations.phone, phone)));
  return again;
}

export function preview(body: string, media: ChatMedia[], direction: "in" | "out", kind: "manual" | "auto" = "manual"): string {
  const text = body.trim();
  const photo = media.length ? (media.length > 1 ? `[${media.length} photos]` : "[Photo]") : "";
  const core = [photo, text].filter(Boolean).join(" ");
  const prefix = direction === "out" ? (kind === "auto" ? "Auto: " : "You: ") : "";
  return (prefix + core).slice(0, 200);
}

export type InboundResult =
  | { ok: true; conversationId: string; messageId: string | null; duplicate: boolean; keyword: "stop" | "start" | "help" | null }
  | { ok: false; reason: "unknown_number" | "bad_request" };

/** A text from a customer, as Twilio posts it to the "A message comes in" webhook. Safe to receive twice. */
export async function receiveText(db: Db, params: Record<string, string>, now = new Date()): Promise<InboundResult> {
  const to = normalizePhone(params.To);
  const from = normalizePhone(params.From);
  const sid = params.MessageSid ?? params.SmsSid;
  if (!to || !from || !sid) return { ok: false, reason: "bad_request" };
  const line = await lineForNumber(db, to);
  if (!line) {
    logger.warn({ to }, "chat: text to a number no store uses");
    return { ok: false, reason: "unknown_number" };
  }
  const conv = await conversationFor(db, line.showroomId, from);
  const body = params.Body ?? "";
  const media: ChatMedia[] = [];
  const n = Math.min(Number(params.NumMedia ?? 0) || 0, 10);
  for (let i = 0; i < n; i++) {
    const url = params[`MediaUrl${i}`];
    if (url) media.push({ url, contentType: params[`MediaContentType${i}`] ?? "application/octet-stream" });
  }
  const [msg] = await db
    .insert(chatMessages)
    .values({ conversationId: conv.id, showroomId: line.showroomId, direction: "in", body, media, twilioSid: sid, status: "received", segments: Number(params.NumSegments) || null, createdAt: now })
    .onConflictDoNothing({ target: chatMessages.twilioSid })
    .returning({ id: chatMessages.id });
  const keyword = optKeyword(body, params.OptOutType);
  if (!msg) return { ok: true, conversationId: conv.id, messageId: null, duplicate: true, keyword };
  await db
    .update(chatConversations)
    .set({
      lastMessageAt: now,
      lastInboundAt: now,
      lastPreview: preview(body, media, "in"),
      ...(keyword === "stop" ? { optedOutAt: now } : keyword === "start" ? { optedOutAt: null } : {}),
    })
    .where(eq(chatConversations.id, conv.id));
  return { ok: true, conversationId: conv.id, messageId: msg.id, duplicate: false, keyword };
}

// Delivery updates can arrive out of order; never move a message backwards (delivered → sent).
const STATUS_RANK: Record<string, number> = { queued: 0, accepted: 0, scheduled: 0, sending: 1, sent: 2, delivered: 3, undelivered: 3, failed: 3, read: 4 };

/** Twilio's status callback for a text we sent. */
export async function applyStatus(db: Db, params: Record<string, string>): Promise<boolean> {
  const sid = params.MessageSid ?? params.SmsSid;
  const status = params.MessageStatus ?? params.SmsStatus;
  if (!sid || !status) return false;
  const [msg] = await db.select().from(chatMessages).where(eq(chatMessages.twilioSid, sid));
  if (!msg || msg.direction !== "out") return false;
  if ((STATUS_RANK[status] ?? 0) < (STATUS_RANK[msg.status] ?? 0)) return true;
  const code = params.ErrorCode || null;
  await db.update(chatMessages).set({ status, ...(code ? { errorCode: code } : {}) }).where(eq(chatMessages.id, msg.id));
  if (code === OPTED_OUT_CODE) await db.update(chatConversations).set({ optedOutAt: new Date() }).where(and(eq(chatConversations.id, msg.conversationId), sql`${chatConversations.optedOutAt} is null`));
  return true;
}

export type SendArgs = {
  showroomId: string;
  conversationId: string;
  body: string;
  /** chat_photos tokens (from savePhoto). */
  photoTokens?: string[];
  staff?: { id: string; name: string } | null;
  kind?: "manual" | "auto";
  autoTag?: string | null;
  sender?: TextSender;
  now?: Date;
};

/**
 * Send a text in a conversation. The message row is written first (so a send that dies mid-way still shows as
 * failed), then handed to Twilio. Refused when the store's line is off, has no number, or the customer opted out.
 */
export async function sendText(db: Db, args: SendArgs): Promise<ChatMessage> {
  const now = args.now ?? new Date();
  const body = plainText(args.body).trim();
  const tokens = args.photoTokens ?? [];
  if (!body && !tokens.length) throw new ChatError("Type a message first.");
  if (body.length > MAX_BODY) throw new ChatError(`That's too long for a text (${MAX_BODY} characters at most).`);
  const line = await getLine(db, args.showroomId);
  if (!line?.number) throw new ChatError("This store has no texting number yet.");
  if (!line.enabled) throw new ChatError("Texting is off for this store.");
  const [conv] = await db.select().from(chatConversations).where(and(eq(chatConversations.id, args.conversationId), eq(chatConversations.showroomId, args.showroomId)));
  if (!conv) throw new ChatError("That conversation isn't in this store.");
  if (conv.optedOutAt) throw new ChatError("This customer texted STOP. They have to text START before you can text them.");

  const media: ChatMedia[] = [];
  for (const token of tokens) {
    const [p] = await db.select({ contentType: chatPhotos.contentType }).from(chatPhotos).where(and(eq(chatPhotos.token, token), eq(chatPhotos.showroomId, args.showroomId)));
    if (!p) throw new ChatError("That photo couldn't be found. Attach it again.");
    media.push({ url: photoUrl(token), contentType: p.contentType });
  }
  const kind = args.kind ?? "manual";
  const [msg] = await db
    .insert(chatMessages)
    .values({
      conversationId: conv.id,
      showroomId: args.showroomId,
      direction: "out",
      kind,
      autoTag: args.autoTag ?? null,
      body,
      media,
      status: "queued",
      staffUserId: args.staff?.id ?? null,
      staffName: args.staff?.name ?? null,
      segments: segmentCount(body) || (media.length ? 1 : 0),
      createdAt: now,
    })
    .returning();
  await db
    .update(chatConversations)
    .set({ lastMessageAt: now, lastPreview: preview(body, media, "out", kind), ...(kind === "manual" ? { readAt: now } : {}) })
    .where(eq(chatConversations.id, conv.id));

  try {
    const sent = await (args.sender ?? getTextSender()).send({
      from: line.number,
      to: conv.phone,
      body,
      mediaUrls: media.map((m) => m.url),
      statusCallback: `${baseUrl()}/api/twilio/status`,
    });
    const [done] = await db.update(chatMessages).set({ twilioSid: sent.sid, status: sent.status }).where(eq(chatMessages.id, msg.id)).returning();
    return done;
  } catch (err) {
    const code = err instanceof TextSendError ? err.code : null;
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ conversationId: conv.id, code, error }, "chat: send failed");
    const [failed] = await db.update(chatMessages).set({ status: "failed", errorCode: code, error }).where(eq(chatMessages.id, msg.id)).returning();
    if (code === OPTED_OUT_CODE) await db.update(chatConversations).set({ optedOutAt: now }).where(eq(chatConversations.id, conv.id));
    return failed;
  }
}

/** Everyone at the store has seen this conversation up to now. */
export async function markRead(db: Db, args: { showroomId: string; conversationId: string; now?: Date }): Promise<void> {
  await db
    .update(chatConversations)
    .set({ readAt: args.now ?? new Date() })
    .where(and(eq(chatConversations.id, args.conversationId), eq(chatConversations.showroomId, args.showroomId)));
}

export function isUnread(c: Pick<ChatConversation, "lastInboundAt" | "readAt">): boolean {
  return !!c.lastInboundAt && (!c.readAt || c.lastInboundAt > c.readAt);
}

export async function unreadCount(db: Db, showroomId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(chatConversations)
    .where(and(eq(chatConversations.showroomId, showroomId), sql`${chatConversations.lastInboundAt} is not null and (${chatConversations.readAt} is null or ${chatConversations.lastInboundAt} > ${chatConversations.readAt})`));
  return r?.n ?? 0;
}

// ---- Staff photos sent to customers: Twilio fetches them by URL, so each gets an unguessable token.

export function photoUrl(token: string): string {
  return `${baseUrl()}/chat-photo/${token}`;
}

const MAX_PHOTO_BYTES = 4_500_000; // Twilio's MMS limit is 5 MB per message.

export async function savePhoto(db: Db, args: { showroomId: string; base64: string; contentType?: string }): Promise<string> {
  const contentType = args.contentType ?? "image/jpeg";
  if (!/^image\/(jpeg|png|gif)$/.test(contentType)) throw new ChatError("Photos must be JPEG, PNG or GIF.");
  const bytes = Math.floor((args.base64.length * 3) / 4);
  if (!args.base64 || bytes > MAX_PHOTO_BYTES) throw new ChatError("That photo is too big to text.");
  const token = generateToken();
  await db.insert(chatPhotos).values({ showroomId: args.showroomId, token, contentType, image: args.base64 });
  return token;
}

export async function photoByToken(db: Db, token: string): Promise<{ contentType: string; image: string } | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [p] = await db.select({ contentType: chatPhotos.contentType, image: chatPhotos.image }).from(chatPhotos).where(eq(chatPhotos.token, token));
  return p ?? null;
}
