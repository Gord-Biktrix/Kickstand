import { and, eq, gte, like, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { events, orders } from "@/db/schema";
import type { Delivery } from "./invite-status";
import { logger } from "./logger";
import { normalizePhone } from "./phone";

/**
 * Carrier delivery reports. Klaviyo accepting an event ("sent") says nothing about whether the text
 * reached the phone; Klaviyo records that separately as "Received Text Message" / "Failed to Deliver
 * Text Message" (and "Received Email" / "Bounced Email") on the customer's profile. The clock pulls
 * those for recent messages and stores them on the msg_* event as payload.delivery.
 */
export type DeliveryReport = { channel: "sms" | "email"; status: "delivered" | "failed" | "bounced"; at: Date; reason?: string };

export interface DeliveryFeed {
  findProfile(contact: { phone: string | null; email: string | null }): Promise<string | null>;
  reports(profileId: string, since: Date): Promise<DeliveryReport[]>;
}

const METRICS: Record<string, Pick<DeliveryReport, "channel" | "status">> = {
  "Received Text Message": { channel: "sms", status: "delivered" },
  "Failed to Deliver Text Message": { channel: "sms", status: "failed" },
  "Received Email": { channel: "email", status: "delivered" },
  "Bounced Email": { channel: "email", status: "bounced" },
};

/** Klaviyo filter datetimes: no milliseconds. */
const kDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export class KlaviyoDeliveryFeed implements DeliveryFeed {
  private metricIds: Promise<Map<string, string>> | null = null;

  constructor(
    private apiKey: string,
    private revision: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async get(path: string): Promise<{ data: unknown[]; links?: { next?: string | null } }> {
    const url = path.startsWith("http") ? path : `https://a.klaviyo.com/api/${path}`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Klaviyo-API-Key ${this.apiKey}`, revision: this.revision, Accept: "application/vnd.api+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Klaviyo ${res.status} on ${url.split("?")[0]}`);
    return res.json();
  }

  private ids(): Promise<Map<string, string>> {
    this.metricIds ??= (async () => {
      const out = new Map<string, string>();
      let next: string | null | undefined = "metrics?fields[metric]=name";
      while (next) {
        const page = await this.get(next);
        for (const m of page.data as { id: string; attributes: { name: string } }[]) {
          if (METRICS[m.attributes.name]) out.set(m.attributes.name, m.id);
        }
        next = page.links?.next;
      }
      return out;
    })().catch((err) => {
      this.metricIds = null;
      throw err;
    });
    return this.metricIds;
  }

  async findProfile({ phone, email }: { phone: string | null; email: string | null }) {
    for (const [field, value] of [["phone_number", phone], ["email", email]] as const) {
      if (!value) continue;
      const page = await this.get(`profiles?fields[profile]=id&filter=${encodeURIComponent(`equals(${field},"${value.replace(/"/g, "")}")`)}`);
      const first = page.data[0] as { id: string } | undefined;
      if (first) return first.id;
    }
    return null;
  }

  async reports(profileId: string, since: Date) {
    const out: DeliveryReport[] = [];
    for (const [name, id] of await this.ids()) {
      const filter = `and(equals(profile_id,"${profileId}"),equals(metric_id,"${id}"),greater-or-equal(datetime,${kDate(since)}))`;
      const page = await this.get(`events?fields[event]=datetime,event_properties&sort=datetime&page[size]=50&filter=${encodeURIComponent(filter)}`);
      for (const e of page.data as { attributes: { datetime: string; event_properties: Record<string, unknown> } }[]) {
        const p = e.attributes.event_properties ?? {};
        // Campaigns and marketing texts to the same person are not ours.
        if (p["Message Type"] === "campaign" || p["Content Type"] === "marketing") continue;
        const reason = [p["Failure Type"], p["Bounce Type"]].find((v) => typeof v === "string") as string | undefined;
        out.push({ ...METRICS[name], at: new Date(e.attributes.datetime), ...(reason ? { reason } : {}) });
      }
    }
    return out.sort((a, b) => a.at.getTime() - b.at.getTime());
  }
}

let override: DeliveryFeed | null | undefined;

export function setDeliveryFeed(f: DeliveryFeed | null | undefined) {
  override = f;
}

export function getDeliveryFeed(): DeliveryFeed | null {
  if (override !== undefined) return override;
  const key = process.env.KLAVIYO_PRIVATE_KEY;
  return key ? new KlaviyoDeliveryFeed(key, process.env.KLAVIYO_REVISION ?? "2025-07-15") : null;
}

const SKEW_MS = 2 * 60_000;
const WINDOW_MS = 48 * 3_600_000;

/**
 * Pair each of our messages with the first report of each channel that arrived after it and before
 * the next message to the same customer. Klaviyo does not link a delivery report to the event that
 * triggered the flow, so time order is the link.
 */
export function attributeReports(messages: { id: string; createdAt: Date }[], reports: DeliveryReport[]): Map<string, { sms?: DeliveryReport; email?: DeliveryReport }> {
  const sorted = [...messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const out = new Map<string, { sms?: DeliveryReport; email?: DeliveryReport }>();
  sorted.forEach((m, i) => {
    const from = m.createdAt.getTime() - SKEW_MS;
    const to = sorted[i + 1] ? sorted[i + 1].createdAt.getTime() - SKEW_MS : m.createdAt.getTime() + WINDOW_MS;
    const inWindow = reports.filter((r) => r.at.getTime() >= from && r.at.getTime() < to);
    out.set(m.id, { sms: inWindow.find((r) => r.channel === "sms"), email: inWindow.find((r) => r.channel === "email") });
  });
  return out;
}

/** Summarise one message's reports. Expected channels decide when we stop asking. */
export function summarise(
  found: { sms?: DeliveryReport; email?: DeliveryReport },
  expect: { sms: boolean; email: boolean },
  ageMs: number,
  now: Date,
): Delivery {
  const sms = found.sms && { status: found.sms.status as "delivered" | "failed", at: found.sms.at.toISOString(), ...(found.sms.reason ? { reason: found.sms.reason } : {}) };
  const email = found.email && { status: found.email.status as "delivered" | "bounced", at: found.email.at.toISOString(), ...(found.email.reason ? { reason: found.email.reason } : {}) };
  const delivered = sms?.status === "delivered" || email?.status === "delivered";
  const failed = sms?.status === "failed" || email?.status === "bounced";
  const resolved = (!expect.sms || !!sms) && (!expect.email || !!email);
  // A flow may be text-only, so a missing email report must not hold a failed text back for long.
  const summary = delivered ? "delivered" : failed && (resolved || ageMs > 2 * 3_600_000) ? "undelivered" : "pending";
  return { ...(sms ? { sms } : {}), ...(email ? { email } : {}), summary, final: resolved || ageMs > 24 * 3_600_000, checked_at: now.toISOString() };
}

export type DeliverySyncSummary = { customers: number; updated: number; errors: number; skipped?: string };

/** Check recent, unresolved messages. Bounded per run so one tick never spends long on Klaviyo. */
export async function syncDeliveryReports(dbx: Db, opts: { now?: Date; feed?: DeliveryFeed | null; maxCustomers?: number; budgetMs?: number } = {}): Promise<DeliverySyncSummary> {
  const now = opts.now ?? new Date();
  const feed = opts.feed === undefined ? getDeliveryFeed() : opts.feed;
  if (!feed) return { customers: 0, updated: 0, errors: 0, skipped: "no Klaviyo key" };
  const started = Date.now();
  const rows = await dbx
    .select({ event: events, order: orders })
    .from(events)
    .innerJoin(orders, eq(orders.id, events.orderId))
    .where(and(like(events.type, "msg_%"), eq(events.klaviyoStatus, "sent"), gte(events.createdAt, new Date(now.getTime() - WINDOW_MS))));

  const byOrder = new Map<string, typeof rows>();
  for (const r of rows) byOrder.set(r.order.id, [...(byOrder.get(r.order.id) ?? []), r]);
  const delivery = (r: (typeof rows)[number]) => (r.event.payload as { delivery?: Delivery }).delivery;
  // Customers with something unresolved, least recently checked first so a backlog rotates.
  const queue = [...byOrder.values()]
    .filter((list) => list.some((r) => !delivery(r)?.final))
    .sort((a, b) => {
      const last = (l: typeof rows) => Math.max(0, ...l.map((r) => Date.parse(delivery(r)?.checked_at ?? "") || 0));
      return last(a) - last(b);
    })
    .slice(0, opts.maxCustomers ?? 25);

  const summary: DeliverySyncSummary = { customers: 0, updated: 0, errors: 0 };
  for (const list of queue) {
    if (Date.now() - started > (opts.budgetMs ?? 15_000)) break;
    const order = list[0].order;
    const phone = normalizePhone(order.customerPhone);
    const expect = { sms: !!phone && order.smsConsent, email: !!order.customerEmail };
    summary.customers++;
    try {
      const profileId = await feed.findProfile({ phone, email: order.customerEmail });
      const since = new Date(Math.min(...list.map((r) => r.event.createdAt.getTime())) - SKEW_MS);
      const reports = profileId ? await feed.reports(profileId, since) : [];
      const found = attributeReports(list.map((r) => ({ id: r.event.id, createdAt: r.event.createdAt })), reports);
      for (const r of list) {
        if (delivery(r)?.final) continue;
        const d = summarise(found.get(r.event.id) ?? {}, expect, now.getTime() - r.event.createdAt.getTime(), now);
        await dbx
          .update(events)
          .set({ payload: sql`${events.payload} || ${JSON.stringify({ delivery: d })}::jsonb` })
          .where(eq(events.id, r.event.id));
        summary.updated++;
      }
    } catch (err) {
      summary.errors++;
      logger.warn({ err: err instanceof Error ? err.message : String(err), orderId: order.id }, "delivery report check failed");
    }
  }
  return summary;
}
