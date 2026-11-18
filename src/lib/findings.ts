/**
 * Findings: work outside the booked job, found by the mechanic (the "+" on the job page).
 *
 * - A finding = the Lightspeed items it needs (prices frozen now), photos, why, and a recommendation level.
 * - Findings are drafts until Send: every draft on the work order goes out together as one request, one Klaviyo
 *   text ("Workshop: Needs your OK") with a link to /ok/<token>, which opens their repair tracker (/t/...), where
 *   they say yes or no to each.
 * - Approved items are added to the Lightspeed work order then (they become Repair tasks on the job page).
 * - A finding never blocks the booked work. Still unanswered at Mark ready = handed over without it ("not_asked").
 * Staff can record an answer given on the phone or at the counter.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { events, findingRequests, findings, ticketPhotos, type Finding, type FindingItem, type FindingRequest } from "@/db/schema";
import { LightspeedClient } from "./lightspeed";
import { logger } from "./logger";
import { baseUrl } from "./messages";
import { getNotifier, type Profile } from "./notifier";
import type { ShowroomCtx } from "./showroom";
import { addWorkorderParts } from "./tickets";
import { decryptToken, encryptToken, generateToken, hashToken } from "./tokens";
import { resolveJob } from "./workshop-moves";

export const NEEDS_OK_METRIC = "Workshop: Needs your OK";

import { isLevel } from "./finding-levels";
export { LEVELS, isLevel, type Level } from "./finding-levels";

export class FindingError extends Error {}

export function findingPrice(items: FindingItem[]): number {
  return items.reduce((s, i) => s + (i.price ?? 0) * i.qty, 0);
}
export function findingMinutes(items: FindingItem[]): number {
  return items.reduce((s, i) => s + (i.minutes ?? 0), 0);
}
export function findingTitle(items: FindingItem[]): string {
  return items.length ? items.map((i) => i.name).join(" + ") : "Extra work";
}
export function findingUrl(token: string): string {
  return `${baseUrl()}/ok/${token}`;
}

/** A draft finding. Photos are base64 JPEGs (kept with the work order's photos; the customer page shows them). */
export async function addFinding(
  db: Db,
  args: { showroomId: string; workorderId: string; level: number; why: string; items: FindingItem[]; photos: string[]; actor: string },
): Promise<Finding> {
  if (!isLevel(args.level)) throw new FindingError("Pick how strongly you recommend it.");
  const items = args.items.filter((i) => i.name.trim() && i.qty > 0);
  if (!items.length) throw new FindingError("Add what it needs (a part or labour from Lightspeed).");
  if (!args.why.trim()) throw new FindingError("Say why, in words the customer will understand.");
  const photoIds = args.photos.length
    ? (await db.insert(ticketPhotos).values(args.photos.map((image) => ({ showroomId: args.showroomId, workorderId: args.workorderId, image, createdBy: args.actor }))).returning({ id: ticketPhotos.id })).map((r) => r.id)
    : [];
  const [f] = await db.insert(findings).values({ showroomId: args.showroomId, workorderId: args.workorderId, level: args.level, why: args.why.trim(), items, photoIds, createdBy: args.actor }).returning();
  return f;
}

/** Remove a finding that hasn't been sent. */
export async function deleteDraft(db: Db, args: { showroomId: string; findingId: string }): Promise<void> {
  await db.delete(findings).where(and(eq(findings.id, args.findingId), eq(findings.showroomId, args.showroomId), isNull(findings.requestId)));
}

export type JobFindings = { findings: Finding[]; requests: (FindingRequest & { url: string })[] };

export async function loadJobFindings(db: Db, workorderId: string): Promise<JobFindings> {
  const rows = await db.select().from(findings).where(eq(findings.workorderId, workorderId)).orderBy(asc(findings.createdAt));
  const reqs = await db.select().from(findingRequests).where(eq(findingRequests.workorderId, workorderId)).orderBy(asc(findingRequests.sentAt));
  return { findings: rows, requests: reqs.map((r) => ({ ...r, url: findingUrl(decryptToken(r.tokenEnc)) })) };
}

export type SendResult = { url: string; count: number; told: "sent" | "failed" | "no_contact" };

/** Send every draft on the job's work order to the customer as one request. */
export async function sendFindings(db: Db, args: { showroom: ShowroomCtx; jobId: string; actor: string; smsConsent: boolean; client?: LightspeedClient }): Promise<SendResult> {
  const { showroom } = args;
  const job = await resolveJob(db, showroom, args.jobId);
  const drafts = await db.select().from(findings).where(and(eq(findings.workorderId, job.workorderId), isNull(findings.requestId)));
  if (!drafts.length) throw new FindingError("There's nothing to send. Press + to add what you found.");

  let profile: Profile | null = null;
  if (job.booking) {
    profile = { email: job.booking.customerEmail, phone: job.booking.customerPhone, name: job.booking.customerName, smsConsent: job.booking.smsConsent || args.smsConsent };
  } else if (job.wo?.customerId) {
    try {
      const c = await (args.client ?? new LightspeedClient(db)).getCustomer(job.wo.customerId);
      if (c) profile = { email: c.email, phone: c.phone, name: c.name, smsConsent: args.smsConsent };
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), workorderId: job.workorderId }, "findings: customer lookup failed");
    }
  }
  const name = profile?.name ?? job.booking?.customerName ?? job.wo?.customerName ?? "";
  const token = generateToken();
  const [request] = await db
    .insert(findingRequests)
    .values({ showroomId: showroom.id, workorderId: job.workorderId, tokenHash: hashToken(token), tokenEnc: encryptToken(token), customerName: name, customerPhone: profile?.phone ?? null, customerEmail: profile?.email ?? null, smsConsent: profile?.smsConsent ?? false, sentBy: args.actor })
    .returning();
  await db.update(findings).set({ requestId: request.id }).where(inArray(findings.id, drafts.map((d) => d.id)));
  const url = findingUrl(token);

  let told: SendResult["told"] = "sent";
  if (!profile || (!profile.email && !profile.phone)) {
    told = "no_contact";
  } else {
    const total = drafts.reduce((s, d) => s + findingPrice(d.items), 0);
    try {
      await getNotifier().send(
        NEEDS_OK_METRIC,
        profile,
        { customer_name: name, first_name: name.split(/\s+/)[0] ?? "", item: job.wo?.item || "", url, count: drafts.length, total: total.toFixed(2), workorder_id: job.workorderId, showroom: showroom.name, showroom_phone: showroom.phone ?? "" },
        `${request.id}:needs-ok`,
      );
    } catch (err) {
      told = "failed";
      logger.warn({ err: err instanceof Error ? err.message : String(err), workorderId: job.workorderId }, "needs-your-OK message not sent");
    }
  }
  await db.update(findingRequests).set({ toldStatus: told }).where(eq(findingRequests.id, request.id));
  await db.insert(events).values({ showroomId: showroom.id, type: "findings_sent", actor: args.actor, payload: { workorder_id: job.workorderId, request_id: request.id, findings: drafts.length, metric: NEEDS_OK_METRIC }, klaviyoStatus: told === "sent" ? "sent" : told === "failed" ? "failed" : null });
  return { url, count: drafts.length, told };
}

export async function requestByToken(db: Db, token: string): Promise<{ request: FindingRequest; findings: Finding[] } | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [request] = await db.select().from(findingRequests).where(eq(findingRequests.tokenHash, hashToken(token)));
  if (!request) return null;
  const rows = await db.select().from(findings).where(eq(findings.requestId, request.id)).orderBy(asc(findings.createdAt));
  return { request, findings: rows };
}

/**
 * Record answers (customer from the link, or staff on their behalf). Only unanswered findings change. Approved
 * items go onto the Lightspeed work order; one Lightspeed refuses is kept on the finding (staff see it).
 */
export async function answerFindings(
  db: Db,
  args: { requestId: string; decisions: Record<string, "approved" | "declined">; by: string; employeeId?: string | null; client?: LightspeedClient; now?: Date },
): Promise<{ approved: number; declined: number; lsFailed: number }> {
  const now = args.now ?? new Date();
  const [request] = await db.select().from(findingRequests).where(eq(findingRequests.id, args.requestId));
  if (!request) throw new FindingError("That request couldn't be found.");
  const rows = await db.select().from(findings).where(eq(findings.requestId, request.id));
  let approved = 0;
  let declined = 0;
  let lsFailed = 0;
  let client: LightspeedClient | null = args.client ?? null;
  for (const f of rows) {
    const d = args.decisions[f.id];
    if (f.decision || !d) continue;
    // Claim it first, so a double tap can't add the lines twice.
    const [claimed] = await db.update(findings).set({ decision: d, decidedAt: now, decidedBy: args.by }).where(and(eq(findings.id, f.id), isNull(findings.decision))).returning({ id: findings.id });
    if (!claimed) continue;
    if (d === "declined") {
      declined++;
      continue;
    }
    approved++;
    client ??= new LightspeedClient(db);
    if (!(await addToWorkorder(db, client, f, args.employeeId ?? null))) lsFailed++;
  }
  const left = (await db.select({ id: findings.id }).from(findings).where(and(eq(findings.requestId, request.id), isNull(findings.decision)))).length;
  if (!left && !request.answeredAt) await db.update(findingRequests).set({ answeredAt: now }).where(eq(findingRequests.id, request.id));
  if (approved || declined) {
    await db.insert(events).values({ showroomId: request.showroomId, type: "findings_answered", actor: args.by, payload: { workorder_id: request.workorderId, request_id: request.id, approved, declined, ls_failed: lsFailed } });
  }
  return { approved, declined, lsFailed };
}

/** Put an approved finding's items on its Lightspeed work order; false (and the reason kept) when Lightspeed refuses. */
async function addToWorkorder(db: Db, client: LightspeedClient, f: Finding, employeeId: string | null): Promise<boolean> {
  try {
    const r = await addWorkorderParts(client, f.workorderId, f.items.map((i) => ({ itemId: i.itemId, name: i.name, qty: i.qty, price: i.price, minutes: i.minutes })), employeeId);
    const ok = r.failed.length === 0;
    await db.update(findings).set({ lsAdded: r.added > 0, lsError: ok ? null : `${r.failed.join(", ")}${r.reason ? `: ${r.reason}` : ""}` }).where(eq(findings.id, f.id));
    return ok;
  } catch (err) {
    await db.update(findings).set({ lsError: err instanceof Error ? err.message : String(err) }).where(eq(findings.id, f.id));
    return false;
  }
}

/**
 * "Changed your mind", either way, while the bike isn't ready (customer on their tracker, or staff for them).
 * - No → yes: its items go on the work order (unless they're still there from an earlier yes).
 * - Yes → no: the answer changes; the lines Kickstand added stay on the work order until staff take them off and
 *   press "Taken off" (ls_added true on a "no" = still to take off).
 */
export async function changeAnswer(
  db: Db,
  args: { findingId: string; workorderId: string; to: "approved" | "declined"; by: string; employeeId?: string | null; client?: LightspeedClient; now?: Date },
): Promise<{ changed: boolean; lsFailed: boolean; takeOff: boolean }> {
  const from = args.to === "approved" ? "declined" : "approved";
  const [f] = await db
    .update(findings)
    .set({ decision: args.to, decidedAt: args.now ?? new Date(), decidedBy: args.by })
    .where(and(eq(findings.id, args.findingId), eq(findings.workorderId, args.workorderId), eq(findings.decision, from)))
    .returning();
  if (!f) return { changed: false, lsFailed: false, takeOff: false };
  let ok = true;
  if (args.to === "approved" && !f.lsAdded) ok = await addToWorkorder(db, args.client ?? new LightspeedClient(db), f, args.employeeId ?? null);
  await db.insert(events).values({ showroomId: f.showroomId, type: "finding_answer_changed", actor: args.by, payload: { workorder_id: f.workorderId, finding_id: f.id, to: args.to, ls_failed: !ok } });
  return { changed: true, lsFailed: !ok, takeOff: args.to === "declined" && f.lsAdded };
}

/** Staff took a changed-to-no finding's lines off the Lightspeed work order. */
export async function markTakenOff(db: Db, args: { findingId: string; showroomId: string; by: string }): Promise<void> {
  const [f] = await db.update(findings).set({ lsAdded: false }).where(and(eq(findings.id, args.findingId), eq(findings.showroomId, args.showroomId), eq(findings.decision, "declined"))).returning();
  if (f) await db.insert(events).values({ showroomId: f.showroomId, type: "finding_taken_off", actor: args.by, payload: { workorder_id: f.workorderId, finding_id: f.id } });
}

/** At Mark ready: anything still unanswered is handed over without it. */
export async function closeUnanswered(db: Db, args: { workorderId: string; by: string; now?: Date }): Promise<number> {
  const rows = await db
    .update(findings)
    .set({ decision: "not_asked", decidedAt: args.now ?? new Date(), decidedBy: args.by })
    .where(and(eq(findings.workorderId, args.workorderId), isNull(findings.decision)))
    .returning({ id: findings.id });
  return rows.length;
}
