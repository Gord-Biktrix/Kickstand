/**
 * What the Messages screen shows: the thread list (with job chips), one conversation, and the panel beside it
 * (open job, what's waiting on the customer's OK, history). Read-only; lib/chat.ts does the writing.
 */
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { bookings, bookingTypes, chatConversations, chatMessages, findingRequests, findings, lsWorkorders, lsWorkorderStatuses, type ChatConversation, type ChatMessage } from "@/db/schema";
import { getLine, isUnread } from "./chat";
import { customerProfile } from "./customers";
import { findingPrice, findingTitle } from "./findings";
import { loadJobLog } from "./job-log";
import { currentStep, deriveTrack, STEP_ORDER, type JobStep } from "./job-track";
import type { ShowroomCtx } from "./showroom";
import { formatInZone } from "./time";
import { trackerUrlFor } from "./tracker";
import { jobPath } from "./workshop";
import { columnOf, workshopColumns } from "./workshop-columns";

export type ThreadFilter = "all" | "unread" | "ok";
export type ChipKind = "ok" | "booked" | "stop";
export type ThreadRow = {
  id: string;
  name: string | null;
  phone: string;
  preview: string;
  lastAt: string;
  unread: boolean;
  chip: { label: string; kind: ChipKind } | null;
};

const last10 = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "").slice(-10);
const digitsSql = (col: unknown) => sql`right(regexp_replace(coalesce(${col}, ''), '\\D', '', 'g'), 10)`;

/** Finding requests still waiting on the customer, by phone (last 10 digits). */
async function waitingOnOk(db: Db, showroomId: string): Promise<Map<string, { workorderId: string; sentAt: Date }>> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await db
    .select({ phone: findingRequests.customerPhone, workorderId: findingRequests.workorderId, sentAt: findingRequests.sentAt })
    .from(findingRequests)
    .where(and(eq(findingRequests.showroomId, showroomId), isNull(findingRequests.answeredAt), gt(findingRequests.sentAt, since)))
    .orderBy(desc(findingRequests.sentAt));
  // Requests closed at Mark ready (every finding "not_asked") are no longer waiting.
  const open = rows.length
    ? new Set(
        (await db.select({ workorderId: findings.workorderId }).from(findings).where(and(inArray(findings.workorderId, rows.map((r) => r.workorderId)), isNull(findings.decision)))).map((f) => f.workorderId),
      )
    : new Set<string>();
  const out = new Map<string, { workorderId: string; sentAt: Date }>();
  for (const r of rows) {
    const k = last10(r.phone);
    if (k && open.has(r.workorderId) && !out.has(k)) out.set(k, { workorderId: r.workorderId, sentAt: r.sentAt });
  }
  return out;
}

async function upcomingVisits(db: Db, showroomId: string, phones: string[]): Promise<Map<string, { type: string; startsAt: Date }>> {
  const out = new Map<string, { type: string; startsAt: Date }>();
  if (!phones.length) return out;
  const rows = await db
    .select({ phone: bookings.customerPhone, startsAt: bookings.startsAt, type: bookingTypes.name })
    .from(bookings)
    .innerJoin(bookingTypes, eq(bookingTypes.id, bookings.bookingTypeId))
    .where(and(eq(bookings.showroomId, showroomId), eq(bookings.status, "booked"), gt(bookings.startsAt, new Date()), inArray(digitsSql(bookings.customerPhone), phones)))
    .orderBy(asc(bookings.startsAt));
  for (const r of rows) {
    const k = last10(r.phone);
    if (!out.has(k)) out.set(k, { type: r.type, startsAt: r.startsAt });
  }
  return out;
}

export function relativeTime(at: Date, now: Date, tz: string): string {
  const day = (d: Date) => formatInZone(d, tz, "yyyy-MM-dd");
  if (day(at) === day(now)) return formatInZone(at, tz, "h:mm a").toLowerCase();
  if (day(at) === day(new Date(now.getTime() - 86_400_000))) return "Yesterday";
  if (now.getTime() - at.getTime() < 6 * 86_400_000) return formatInZone(at, tz, "EEE");
  return formatInZone(at, tz, "MMM d");
}

function visitWhen(at: Date, now: Date, tz: string): string {
  const time = formatInZone(at, tz, "h:mm a").toLowerCase();
  return formatInZone(at, tz, "yyyy-MM-dd") === formatInZone(now, tz, "yyyy-MM-dd") ? `today ${time}` : `${formatInZone(at, tz, "EEE")} ${time}`;
}

export async function listThreads(db: Db, showroom: ShowroomCtx, opts: { q?: string; filter?: ThreadFilter; now?: Date } = {}): Promise<ThreadRow[]> {
  const now = opts.now ?? new Date();
  const q = (opts.q ?? "").trim();
  const ok = await waitingOnOk(db, showroom.id);
  const conds = [eq(chatConversations.showroomId, showroom.id)];
  if (q) {
    const digits = q.replace(/\D/g, "");
    const parts = [sql`${chatConversations.name} ilike ${`%${q}%`}`];
    if (digits.length >= 3) {
      parts.push(sql`regexp_replace(${chatConversations.phone}, '\\D', '', 'g') like ${`%${digits}%`}`);
      // WO #: the phone on that work order's booking or finding request.
      parts.push(sql`right(regexp_replace(${chatConversations.phone}, '\\D', '', 'g'), 10) in (
        select ${digitsSql(bookings.customerPhone)} from ${bookings} where ${bookings.showroomId} = ${showroom.id} and ${bookings.lsWorkorderId} = ${digits}
        union select ${digitsSql(findingRequests.customerPhone)} from ${findingRequests} where ${findingRequests.showroomId} = ${showroom.id} and ${findingRequests.workorderId} = ${digits})`);
    }
    conds.push(sql`(${sql.join(parts, sql` or `)})`);
  }
  if (opts.filter === "unread") conds.push(sql`${chatConversations.lastInboundAt} is not null and (${chatConversations.readAt} is null or ${chatConversations.lastInboundAt} > ${chatConversations.readAt})`);
  if (opts.filter === "ok") {
    const phones = [...ok.keys()];
    if (!phones.length) return [];
    conds.push(inArray(sql`right(regexp_replace(${chatConversations.phone}, '\\D', '', 'g'), 10)`, phones));
  }
  const rows = await db.select().from(chatConversations).where(and(...conds)).orderBy(desc(chatConversations.lastMessageAt)).limit(150);
  const visits = await upcomingVisits(db, showroom.id, [...new Set(rows.map((r) => last10(r.phone)))]);
  return rows.map((c) => {
    const k = last10(c.phone);
    const wait = ok.get(k);
    const visit = visits.get(k);
    const chip: ThreadRow["chip"] = c.optedOutAt
      ? { label: "Opted out", kind: "stop" }
      : wait
        ? { label: `WO #${wait.workorderId} · Waiting on OK`, kind: "ok" }
        : visit
          ? { label: `${visit.type} · ${visitWhen(visit.startsAt, now, showroom.timezone)}`, kind: "booked" }
          : null;
    return { id: c.id, name: c.name, phone: c.phone, preview: c.lastPreview, lastAt: relativeTime(c.lastMessageAt, now, showroom.timezone), unread: isUnread(c), chip };
  });
}

export async function waitingCount(db: Db, showroomId: string): Promise<number> {
  return (await waitingOnOk(db, showroomId)).size;
}

export type MessageView = {
  id: string;
  direction: "in" | "out";
  kind: "manual" | "auto";
  autoTag: string | null;
  body: string;
  photos: string[];
  status: string;
  error: string | null;
  who: string | null;
  time: string;
  day: string | null;
};

const STATUS_LABEL: Record<string, string> = { queued: "Sending", accepted: "Sending", sending: "Sending", sent: "Sent", delivered: "Delivered", read: "Read", undelivered: "Not delivered", failed: "Failed", received: "" };

export function messageViews(rows: ChatMessage[], tz: string, now: Date): MessageView[] {
  let lastDay = "";
  return rows.map((m) => {
    const d = formatInZone(m.createdAt, tz, "yyyy-MM-dd");
    const label = d === formatInZone(now, tz, "yyyy-MM-dd") ? "Today" : d === formatInZone(new Date(now.getTime() - 86_400_000), tz, "yyyy-MM-dd") ? "Yesterday" : formatInZone(m.createdAt, tz, "EEE, MMM d");
    const day = d === lastDay ? null : label;
    lastDay = d;
    return {
      id: m.id,
      direction: m.direction as "in" | "out",
      kind: m.kind as "manual" | "auto",
      autoTag: m.autoTag,
      body: m.body,
      photos: m.media.map((x, i) => (m.direction === "in" ? `/api/chat/media/${m.id}/${i}` : x.url)),
      status: STATUS_LABEL[m.status] ?? m.status,
      error: m.status === "failed" || m.status === "undelivered" ? (m.errorCode === "21610" ? "Customer opted out" : m.error ?? (m.errorCode ? `Error ${m.errorCode}` : null)) : null,
      who: m.staffName,
      time: formatInZone(m.createdAt, tz, "h:mm a").toLowerCase(),
      day,
    };
  });
}

export type PanelJob = {
  workorderId: string;
  href: string;
  title: string;
  step: JobStep;
  steps: JobStep[];
  waiting: { title: string; price: number; sentAt: string } | null;
  trackerUrl: string | null;
};

export type ThreadView = {
  conversation: Pick<ChatConversation, "id" | "name" | "phone"> & { optedOut: boolean };
  messages: MessageView[];
  customerHref: string;
  job: PanelJob | null;
  history: { label: string; when: string }[];
  texts: number;
  canSend: boolean;
  lineState: "off" | "no_number" | "on";
};

/** The customer's latest work order in this store that Kickstand knows their phone for (a booking or a finding). */
async function latestJob(db: Db, showroom: ShowroomCtx, phone: string, now: Date): Promise<PanelJob | null> {
  const k = last10(phone);
  const since = new Date(now.getTime() - 90 * 86_400_000);
  const [b] = await db
    .select({ id: bookings.id, wo: bookings.lsWorkorderId, at: bookings.startsAt, type: bookingTypes.name })
    .from(bookings)
    .innerJoin(bookingTypes, eq(bookingTypes.id, bookings.bookingTypeId))
    .where(and(eq(bookings.showroomId, showroom.id), sql`${bookings.lsWorkorderId} is not null`, sql`${bookings.status} <> 'cancelled'`, gt(bookings.startsAt, since), eq(digitsSql(bookings.customerPhone), k)))
    .orderBy(desc(bookings.startsAt))
    .limit(1);
  const [f] = await db
    .select({ wo: findingRequests.workorderId, at: findingRequests.sentAt })
    .from(findingRequests)
    .where(and(eq(findingRequests.showroomId, showroom.id), gt(findingRequests.sentAt, since), eq(digitsSql(findingRequests.customerPhone), k)))
    .orderBy(desc(findingRequests.sentAt))
    .limit(1);
  const workorderId = f && (!b || f.at > b.at) ? f.wo : b?.wo;
  if (!workorderId) return null;
  const [wo] = await db.select().from(lsWorkorders).where(eq(lsWorkorders.id, workorderId));
  if (!wo) return null; // paid or archived: no longer open
  const statuses = await db.select().from(lsWorkorderStatuses);
  const column = columnOf(workshopColumns(showroom.settings, statuses), wo.statusId) ?? "todo";
  const track = deriveTrack(await loadJobLog(db, workorderId), now);
  const pending = await db
    .select({ items: findings.items, sentAt: findingRequests.sentAt })
    .from(findings)
    .innerJoin(findingRequests, eq(findingRequests.id, findings.requestId))
    .where(and(eq(findings.workorderId, workorderId), isNull(findings.decision)));
  const jobId = b && b.wo === workorderId ? `b:${b.id}` : `w:${workorderId}`;
  return {
    workorderId,
    href: jobPath(jobId),
    title: (b && b.wo === workorderId ? b.type : null) ?? wo.item ?? "Repair",
    step: currentStep(track, column),
    steps: STEP_ORDER,
    waiting: pending.length
      ? { title: findingTitle(pending.flatMap((p) => p.items)), price: pending.reduce((s, p) => s + findingPrice(p.items), 0), sentAt: formatInZone(pending[0].sentAt, showroom.timezone, "h:mm a").toLowerCase() }
      : null,
    trackerUrl: await trackerUrlFor(db, workorderId),
  };
}

export async function loadThread(db: Db, showroom: ShowroomCtx, conversationId: string, now = new Date()): Promise<ThreadView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return null;
  const [conv] = await db.select().from(chatConversations).where(and(eq(chatConversations.id, conversationId), eq(chatConversations.showroomId, showroom.id)));
  if (!conv) return null;
  const rows = await db.select().from(chatMessages).where(eq(chatMessages.conversationId, conv.id)).orderBy(desc(chatMessages.createdAt)).limit(300);
  rows.reverse();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(chatMessages).where(eq(chatMessages.conversationId, conv.id));
  const key = `ph:${last10(conv.phone)}`;
  const profile = await customerProfile(db, showroom, key);
  const history = [
    ...(profile?.orders ?? []).map((o) => ({ label: `Bought ${o.model}`, at: new Date(`${o.orderDate}T12:00:00Z`) })),
    ...(profile?.visits ?? []).filter((v) => v.booking.status !== "cancelled").map((v) => ({ label: v.type.name, at: v.booking.startsAt })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 5)
    .map((h) => ({ label: h.label, when: formatInZone(h.at, showroom.timezone, "MMM yyyy") }));
  const line = await getLine(db, showroom.id);
  const lineState = !line?.number ? "no_number" : line.enabled ? "on" : "off";
  return {
    conversation: { id: conv.id, name: conv.name, phone: conv.phone, optedOut: !!conv.optedOutAt },
    messages: messageViews(rows, showroom.timezone, now),
    customerHref: profile ? `/app/customers/${encodeURIComponent(profile.key)}` : `/app/search?q=${encodeURIComponent(last10(conv.phone))}`,
    job: await latestJob(db, showroom, conv.phone, now),
    history,
    texts: n,
    canSend: lineState === "on" && !conv.optedOutAt,
    lineState,
  };
}

/** (780) 555-0137 */
export function formatPhone(e164: string): string {
  const d = e164.replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : e164;
}

/** The open job for a conversation's customer (for "Send tracker link"). */
export async function jobForConversation(db: Db, showroom: ShowroomCtx, conversationId: string): Promise<{ job: PanelJob; name: string } | null> {
  const [conv] = await db.select().from(chatConversations).where(and(eq(chatConversations.id, conversationId), eq(chatConversations.showroomId, showroom.id)));
  if (!conv) return null;
  const job = await latestJob(db, showroom, conv.phone, new Date());
  return job ? { job, name: conv.name ?? "" } : null;
}
