import { logger } from "./logger";

/**
 * Staff pings go to each store's Slack channel through an incoming webhook (Slack app → Incoming
 * Webhooks → Add to channel). One-way: people act in Kickstand from the link in the message.
 *
 * Booking messages can instead go through the Slack bot (SLACK_BOT_TOKEN, scope chat:write, invited to the
 * channel; the store's channel ID in Settings › Program › Slack). The bot gets each message's id back, so a
 * booking is one message and later moves and cancellations reply in its thread.
 */
export type SlackMessage = { text: string; blocks?: unknown[] };

export interface SlackPoster {
  /** Must throw when Slack does not accept the message. */
  post(webhookUrl: string, message: SlackMessage): Promise<void>;
}

class WebhookPoster implements SlackPoster {
  async post(webhookUrl: string, message: SlackMessage) {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Slack ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`);
  }
}

export class MemorySlack implements SlackPoster {
  posted: { webhookUrl: string; message: SlackMessage }[] = [];
  failNext = 0;
  async post(webhookUrl: string, message: SlackMessage) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("simulated Slack failure");
    }
    this.posted.push({ webhookUrl, message });
  }
}

/** Posting as the Slack bot: returns the message's ts (its id), which thread replies and updates need. */
export interface SlackBot {
  post(channel: string, message: SlackMessage, threadTs?: string): Promise<string>;
  update(channel: string, ts: string, message: SlackMessage): Promise<void>;
}

class ApiBot implements SlackBot {
  constructor(private token: string) {}
  private async call(method: string, body: Record<string, unknown>) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; ts?: string };
    if (!res.ok || !json.ok) throw new Error(`Slack ${method}: ${json.error ?? res.status}`);
    return json;
  }
  async post(channel: string, message: SlackMessage, threadTs?: string) {
    const json = await this.call("chat.postMessage", { channel, ...message, ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false });
    return json.ts ?? "";
  }
  async update(channel: string, ts: string, message: SlackMessage) {
    await this.call("chat.update", { channel, ts, ...message });
  }
}

export class MemorySlackBot implements SlackBot {
  posts: { channel: string; message: SlackMessage; threadTs?: string; ts: string }[] = [];
  updates: { channel: string; ts: string; message: SlackMessage }[] = [];
  failNext = 0;
  private n = 0;
  async post(channel: string, message: SlackMessage, threadTs?: string) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("simulated Slack failure");
    }
    const ts = `1700000000.${String(++this.n).padStart(6, "0")}`;
    this.posts.push({ channel, message, threadTs, ts });
    return ts;
  }
  async update(channel: string, ts: string, message: SlackMessage) {
    this.updates.push({ channel, ts, message });
  }
}

let botOverride: SlackBot | null | undefined;

/** Tests: a fake bot, or null for "no bot configured". */
export function setSlackBot(b: SlackBot | null | undefined) {
  botOverride = b;
}

export function getSlackBot(): SlackBot | null {
  if (botOverride !== undefined) return botOverride;
  const token = process.env.SLACK_BOT_TOKEN;
  return token ? new ApiBot(token) : null;
}

let override: SlackPoster | null = null;

export function setSlackPoster(p: SlackPoster | null) {
  override = p;
}

export function getSlackPoster(): SlackPoster {
  return override ?? new WebhookPoster();
}

/** Only Slack's own webhook host: the URL is stored per store and posted to by the server. */
export function isSlackWebhookUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "hooks.slack.com" && u.pathname.startsWith("/services/");
  } catch {
    return false;
  }
}

/** Slack mrkdwn needs &, < and > escaped in anything we did not write ourselves. */
export function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type UnbookedPing = {
  store: string;
  customer: string;
  phone: string | null;
  email: string | null;
  bike: string;
  boxTag: string;
  days: number;
  invitedOn: string;
  inviteStatus: string;
  url: string;
};

/** One message per customer: who, how to reach them, what we already know about the invite, one link. */
export function unbookedPingMessage(p: UnbookedPing): SlackMessage {
  const e = slackEscape;
  const contact = [p.phone, p.email].filter(Boolean).map((c) => e(c!)).join(" · ") || "_no phone or email on the order_";
  const lines = [
    `:telephone_receiver: *${e(p.customer)}* hasn't booked their pickup — invited ${p.days} days ago (${e(p.invitedOn)}). Please call them and agree a time.`,
    `*Bike:* ${e(p.bike)} · box ${e(p.boxTag)}`,
    `*Contact:* ${contact}`,
    `*Invite:* ${e(p.inviteStatus)}`,
    `<${p.url}|Open in Kickstand> to book them in (no text is sent) or fix their contact details.`,
  ];
  return {
    text: `${p.store}: ${p.customer} hasn't booked — invited ${p.days} days ago`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }],
  };
}

export type BookingSlackPing = {
  kind: "new" | "rescheduled" | "cancelled";
  /** Replaces the heading, e.g. on the original message once the booking has moved or been cancelled. */
  heading?: string;
  store: string;
  type: string;
  when: string;
  previous?: string;
  customer: string;
  phone: string | null;
  email: string | null;
  answers: { question: string; answer: string }[];
  note: string;
  url: string;
};

/** A booking made, moved or cancelled, for the store's channel (Biktrix Online: #callback-request). */
export function bookingSlackMessage(p: BookingSlackPing): SlackMessage {
  const e = slackEscape;
  const head = p.heading ?? { new: "📅 New booking", rescheduled: "🔁 Booking moved", cancelled: "❌ Booking cancelled" }[p.kind];
  const lines = [
    `*${head}: ${e(p.type)}* · ${e(p.store)}`,
    `*When:* ${e(p.when)}${p.previous ? ` _(was ${e(p.previous)})_` : ""}`,
    `*Customer:* ${e(p.customer)}${p.phone ? ` · <tel:${p.phone}|${e(p.phone)}>` : ""}${p.email ? ` · <mailto:${p.email}|${e(p.email)}>` : ""}`,
    ...p.answers.map((a) => `*${e(a.question)}* ${e(a.answer)}`),
    p.note ? `*Note:* ${e(p.note)}` : "",
    `<${p.url}|Open in Kickstand>`,
  ].filter(Boolean);
  return {
    text: `${head}: ${p.type} · ${p.customer} · ${p.when}`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }],
  };
}

/** The short reply in a booking's thread when it moves or is cancelled (the original carries the details). */
export function bookingThreadReply(p: { kind: "rescheduled" | "cancelled"; when: string; previous?: string; url: string; by?: string }): SlackMessage {
  const e = slackEscape;
  const line = p.kind === "rescheduled"
    ? `🔁 *Moved to ${e(p.when)}*${p.previous ? ` _(was ${e(p.previous)})_` : ""}`
    : `❌ *Cancelled* (was ${e(p.when)})`;
  const text = `${line}${p.by ? ` · ${e(p.by)}` : ""} · <${p.url}|Open in Kickstand>`;
  return { text: line.replace(/[*_]/g, ""), blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

/** Post, logging instead of throwing. Returns the error message on failure. */
export async function postSlack(webhookUrl: string, message: SlackMessage): Promise<string | null> {
  try {
    await getSlackPoster().post(webhookUrl, message);
    return null;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ error }, "slack post failed");
    return error;
  }
}
