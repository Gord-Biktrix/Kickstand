import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { chatConversations, chatMessages, chatPhotos } from "@/db/schema";
import { applyStatus, ChatError, conversationFor, isUnread, markRead, receiveText, saveLine, savePhoto, sendText, unreadCount } from "@/lib/chat";
import { MemorySender, optKeyword, plainText, segmentCount, setTextSender, twilioSignature, verifyTwilioSignature } from "@/lib/sms";
import { handleTwilioWebhook } from "@/lib/twilio-webhook";
import type { ShowroomCtx } from "@/lib/showroom";
import { makeOrder, resetDb, testDb } from "./helpers";

const STORE = "+15875550100";
const CUSTOMER = "+17805550137";
const TOKEN = "test-auth-token";
const STAFF = { id: "11111111-1111-4111-8111-111111111111", name: "Riley" };

let sid = 0;
const inbound = (body: string, extra: Record<string, string> = {}) => ({ MessageSid: `SMin${++sid}`, From: CUSTOMER, To: STORE, Body: body, NumMedia: "0", ...extra });

function signedRequest(url: string, params: Record<string, string>, token = TOKEN) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": twilioSignature(token, url, params) },
    body: new URLSearchParams(params).toString(),
  });
}

describe("sms helpers", () => {
  it("matches Twilio's documented signature example", () => {
    // https://www.twilio.com/docs/usage/security#validating-requests
    const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
    const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };
    expect(twilioSignature("12345", url, params)).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
    expect(verifyTwilioSignature("12345", url, params, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=")).toBe(true);
    expect(verifyTwilioSignature("12345", url, { ...params, Digits: "9" }, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=")).toBe(false);
    expect(verifyTwilioSignature("12345", url, params, null)).toBe(false);
  });

  it("counts segments: 160 plain characters, 70 once a curly quote sneaks in", () => {
    expect(segmentCount("a".repeat(160))).toBe(1);
    expect(segmentCount("a".repeat(161))).toBe(2);
    expect(segmentCount("It’s ready")).toBe(1);
    expect(segmentCount("It’s " + "a".repeat(70))).toBe(2);
    expect(segmentCount(plainText("It’s " + "a".repeat(70)))).toBe(1);
    expect(segmentCount("")).toBe(0);
  });

  it("knows the opt-out keywords", () => {
    expect(optKeyword("stop")).toBe("stop");
    expect(optKeyword(" Unsubscribe. ")).toBe("stop");
    expect(optKeyword("START")).toBe("start");
    expect(optKeyword("help")).toBe("help");
    expect(optKeyword("please stop by at 3")).toBeNull();
    expect(optKeyword("anything", "STOP")).toBe("stop");
  });
});

describe("chat: two-way texting", () => {
  let db: Db;
  let van: ShowroomCtx;
  let sender: MemorySender;

  beforeAll(async () => {
    db = await testDb();
    process.env.AUTH_SECRET ??= "test-secret-for-tokens";
  });
  afterAll(async () => {
    setTextSender(null);
    await db.$client.end();
  });
  beforeEach(async () => {
    van = await resetDb(db);
    await db.delete(chatPhotos);
    sender = new MemorySender();
    setTextSender(sender);
    await saveLine(db, van.id, { number: "(587) 555-0100", enabled: true, numberState: "live" });
  });

  it("files an inbound text under the store and customer, named from their order, once", async () => {
    await makeOrder(db, van, { customerName: "Dana Morrow", customerPhone: "780-555-0137" });
    const params = inbound("Any idea when it'll be ready?");
    const first = await receiveText(db, params);
    const again = await receiveText(db, params);
    expect(first.ok && !first.duplicate).toBe(true);
    expect(again.ok && again.duplicate).toBe(true);
    const [conv] = await db.select().from(chatConversations);
    expect(conv).toMatchObject({ showroomId: van.id, phone: CUSTOMER, name: "Dana Morrow", lastPreview: "Any idea when it'll be ready?" });
    expect(isUnread(conv)).toBe(true);
    expect(await unreadCount(db, van.id)).toBe(1);
    expect(await db.select().from(chatMessages)).toHaveLength(1);
    await markRead(db, { showroomId: van.id, conversationId: conv.id });
    expect(await unreadCount(db, van.id)).toBe(0);
  });

  it("keeps customer photos", async () => {
    await receiveText(db, inbound("", { NumMedia: "1", MediaUrl0: "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1", MediaContentType0: "image/jpeg" }));
    const [msg] = await db.select().from(chatMessages);
    expect(msg.media).toEqual([{ url: "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1", contentType: "image/jpeg" }]);
    const [conv] = await db.select().from(chatConversations);
    expect(conv.lastPreview).toBe("[Photo]");
  });

  it("ignores texts to a number no store uses", async () => {
    expect(await receiveText(db, { ...inbound("hi"), To: "+15875559999" })).toEqual({ ok: false, reason: "unknown_number" });
  });

  it("sends a reply from the store number and follows its delivery", async () => {
    const conv = await conversationFor(db, van.id, CUSTOMER);
    const msg = await sendText(db, { showroomId: van.id, conversationId: conv.id, body: "Should be Thursday — we’ll text you.", staff: STAFF });
    expect(sender.sent).toEqual([{ from: STORE, to: CUSTOMER, body: "Should be Thursday - we'll text you.", mediaUrls: [], statusCallback: "http://localhost:3000/api/twilio/status" }]);
    expect(msg).toMatchObject({ direction: "out", status: "queued", staffName: "Riley", segments: 1, twilioSid: "SMtest000001" });

    await applyStatus(db, { MessageSid: "SMtest000001", MessageStatus: "delivered" });
    await applyStatus(db, { MessageSid: "SMtest000001", MessageStatus: "sent" }); // late, out of order
    const [after] = await db.select().from(chatMessages).where(eq(chatMessages.id, msg.id));
    expect(after.status).toBe("delivered");
  });

  it("sends a photo by a link Twilio can fetch", async () => {
    const conv = await conversationFor(db, van.id, CUSTOMER);
    const token = await savePhoto(db, { showroomId: van.id, base64: Buffer.from("jpeg").toString("base64") });
    await sendText(db, { showroomId: van.id, conversationId: conv.id, body: "", photoTokens: [token], staff: STAFF });
    expect(sender.sent[0].mediaUrls).toEqual([`http://localhost:3000/chat-photo/${token}`]);
  });

  it("texts nobody while the store is off, or before it has a number", async () => {
    const conv = await conversationFor(db, van.id, CUSTOMER);
    await saveLine(db, van.id, { enabled: false });
    await expect(sendText(db, { showroomId: van.id, conversationId: conv.id, body: "hi", staff: STAFF })).rejects.toThrow("Texting is off");
    await saveLine(db, van.id, { enabled: true, number: null });
    await expect(sendText(db, { showroomId: van.id, conversationId: conv.id, body: "hi", staff: STAFF })).rejects.toThrow(ChatError);
    expect(sender.sent).toHaveLength(0);
  });

  it("honours STOP and START", async () => {
    await receiveText(db, inbound("STOP"));
    const [conv] = await db.select().from(chatConversations);
    expect(conv.optedOutAt).not.toBeNull();
    await expect(sendText(db, { showroomId: van.id, conversationId: conv.id, body: "hi", staff: STAFF })).rejects.toThrow("texted STOP");
    await receiveText(db, inbound("start"));
    await sendText(db, { showroomId: van.id, conversationId: conv.id, body: "Welcome back", staff: STAFF });
    expect(sender.sent).toHaveLength(1);
  });

  it("records an opt-out Twilio reports on send", async () => {
    const conv = await conversationFor(db, van.id, CUSTOMER);
    sender.failNext = ["21610"];
    const msg = await sendText(db, { showroomId: van.id, conversationId: conv.id, body: "hi", staff: STAFF });
    expect(msg).toMatchObject({ status: "failed", errorCode: "21610" });
    const [after] = await db.select().from(chatConversations);
    expect(after.optedOutAt).not.toBeNull();
  });

  it("webhooks: refuse unsigned or mis-signed posts, accept Twilio's", async () => {
    const url = "https://kickstand.example/api/twilio/inbound";
    const params = inbound("Hello");
    expect((await handleTwilioWebhook(db, signedRequest(url, params, "wrong-token"), "inbound", TOKEN)).status).toBe(403);
    expect((await handleTwilioWebhook(db, signedRequest(url, params), "inbound", undefined)).status).toBe(503);
    const ok = await handleTwilioWebhook(db, signedRequest(url, params), "inbound", TOKEN);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("<Response></Response>");
    expect(await db.select().from(chatMessages)).toHaveLength(1);

    const conv = await conversationFor(db, van.id, CUSTOMER);
    await sendText(db, { showroomId: van.id, conversationId: conv.id, body: "Hi", staff: STAFF });
    const status = await handleTwilioWebhook(db, signedRequest("https://kickstand.example/api/twilio/status", { MessageSid: "SMtest000001", MessageStatus: "undelivered", ErrorCode: "30003" }), "status", TOKEN);
    expect(status.status).toBe(204);
    const [out] = await db.select().from(chatMessages).where(eq(chatMessages.twilioSid, "SMtest000001"));
    expect(out).toMatchObject({ status: "undelivered", errorCode: "30003" });
  });
});
