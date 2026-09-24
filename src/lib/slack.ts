import { logger } from "./logger";

/**
 * Staff pings go to each store's Slack channel through an incoming webhook (Slack app → Incoming
 * Webhooks → Add to channel). One-way: people act in Kickstand from the link in the message.
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
