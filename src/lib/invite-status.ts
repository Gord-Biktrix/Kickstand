import type { Unit } from "@/db/schema";

/**
 * What we know about whether a customer got their invite, strongest signal first:
 * they opened the link > the carrier delivered a text/email > Klaviyo accepted it > it failed.
 * Delivery reports come from Klaviyo (src/lib/delivery.ts) and lag the send by minutes to hours.
 */
export type Delivery = {
  sms?: { status: "delivered" | "failed"; at: string; reason?: string };
  email?: { status: "delivered" | "bounced"; at: string; reason?: string };
  summary: "delivered" | "undelivered" | "pending";
  final: boolean;
  checked_at: string;
};

export type MessageInfo = {
  metric: string;
  klaviyoStatus: string | null;
  createdAt: Date;
  error?: string;
  delivery?: Delivery;
};

export type InviteStatusKey = "opened" | "delivered" | "undelivered" | "failed" | "sent" | "none";

export type InviteStatus = {
  key: InviteStatusKey;
  label: string;
  tone: "ok" | "neutral" | "warn" | "danger";
  /** One line for a tooltip, the bike page and Slack. */
  detail: string;
  at: Date | null;
};

export function readMessage(e: { payload: unknown; klaviyoStatus: string | null; createdAt: Date; type: string }): MessageInfo {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  return {
    metric: String(p.metric ?? e.type),
    klaviyoStatus: e.klaviyoStatus,
    createdAt: e.createdAt,
    error: typeof p.error === "string" ? p.error : undefined,
    delivery: p.delivery && typeof p.delivery === "object" ? (p.delivery as Delivery) : undefined,
  };
}

function failureReason(d: Delivery): string {
  return [d.sms?.status === "failed" ? `text: ${d.sms.reason ?? "not delivered"}` : null, d.email?.status === "bounced" ? `email: ${d.email.reason ?? "bounced"}` : null]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Null for bikes that were never invited. `messages` are the unit's msg_* events; only those sent since
 * the invite count (an older booking's texts say nothing about this invite).
 */
export function inviteStatus(unit: Pick<Unit, "invitedAt" | "linkOpenedAt">, messages: MessageInfo[]): InviteStatus | null {
  if (!unit.invitedAt) return null;
  if (unit.linkOpenedAt) return { key: "opened", label: "Opened link", tone: "ok", detail: "The customer opened their booking link", at: unit.linkOpenedAt };
  const since = unit.invitedAt.getTime() - 60_000;
  const msgs = messages.filter((m) => m.createdAt.getTime() >= since).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (msgs.length === 0) return { key: "none", label: "No text sent", tone: "warn", detail: "Invited without a message (booked by staff, or sent before tracking) — the customer may not know", at: null };

  const delivered = msgs.find((m) => m.delivery?.summary === "delivered");
  if (delivered) {
    const how = delivered.delivery!.sms?.status === "delivered" ? "Text" : "Email";
    return { key: "delivered", label: "Delivered", tone: "ok", detail: `${how} delivered (${delivered.metric.replace(/^Pickup:\s*/, "")}) — not opened yet`, at: delivered.createdAt };
  }
  const accepted = msgs.filter((m) => m.klaviyoStatus === "sent");
  const pending = accepted.find((m) => !m.delivery || m.delivery.summary === "pending");
  const undelivered = accepted.find((m) => m.delivery?.summary === "undelivered");
  if (undelivered && !pending) {
    return { key: "undelivered", label: "Not delivered", tone: "danger", detail: `Didn't reach them — ${failureReason(undelivered.delivery!) || "carrier rejected it"}. Check the phone and email`, at: undelivered.createdAt };
  }
  if (accepted.length > 0) return { key: "sent", label: "Sent", tone: "neutral", detail: "Sent — no delivery report yet", at: accepted[0].createdAt };
  return { key: "failed", label: "Invite failed", tone: "danger", detail: `Not sent — ${msgs[0].error ?? "Klaviyo refused it"}`, at: msgs[0].createdAt };
}
