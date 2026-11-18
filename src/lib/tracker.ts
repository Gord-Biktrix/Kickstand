/**
 * The customer's repair tracker: a link (/t/<token>) that shows where their bike is (Check in → Inspection →
 * Repair → Pickup), what's being done, what's waiting on their OK, and when it should be ready. One per work
 * order; texted through Klaviyo ("Workshop: Checked in") when the bike is checked in, or when staff send it.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { events, jobTrackers, type Booking, type JobTracker, type LsWorkorder } from "@/db/schema";
import { LightspeedClient } from "./lightspeed";
import { logger } from "./logger";
import { baseUrl } from "./messages";
import { getNotifier, type Profile } from "./notifier";
import type { ShowroomCtx } from "./showroom";
import { decryptToken, encryptToken, generateToken, hashToken } from "./tokens";
import { resolveJob } from "./workshop-moves";

export const CHECKED_IN_METRIC = "Workshop: Checked in";

export function trackerUrl(token: string): string {
  return `${baseUrl()}/t/${token}`;
}

/** The work order's tracker link, made on first use. */
export async function ensureTracker(db: Db, args: { showroomId: string; workorderId: string; customerName: string }): Promise<{ tracker: JobTracker; url: string }> {
  const [found] = await db.select().from(jobTrackers).where(eq(jobTrackers.workorderId, args.workorderId));
  if (found) return { tracker: found, url: trackerUrl(decryptToken(found.tokenEnc)) };
  const token = generateToken();
  const [made] = await db
    .insert(jobTrackers)
    .values({ showroomId: args.showroomId, workorderId: args.workorderId, tokenHash: hashToken(token), tokenEnc: encryptToken(token), customerName: args.customerName })
    .onConflictDoNothing({ target: jobTrackers.workorderId })
    .returning();
  if (made) return { tracker: made, url: trackerUrl(token) };
  // Made at the same moment by another request: use theirs.
  const [again] = await db.select().from(jobTrackers).where(eq(jobTrackers.workorderId, args.workorderId));
  return { tracker: again, url: trackerUrl(decryptToken(again.tokenEnc)) };
}

/** The tracker URL if the work order has one (for the Ready text). */
export async function trackerUrlFor(db: Db, workorderId: string): Promise<string | null> {
  const [t] = await db.select({ tokenEnc: jobTrackers.tokenEnc }).from(jobTrackers).where(eq(jobTrackers.workorderId, workorderId));
  return t ? trackerUrl(decryptToken(t.tokenEnc)) : null;
}

export async function trackerByToken(db: Db, token: string): Promise<JobTracker | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [t] = await db.select().from(jobTrackers).where(eq(jobTrackers.tokenHash, hashToken(token)));
  return t ?? null;
}

/** Who to text about a job: the booking's details, else the Lightspeed customer (texts only if they agreed now). */
export async function jobProfile(db: Db, job: { booking: Booking | null; wo: LsWorkorder | null; workorderId: string }, smsConsent: boolean, client?: LightspeedClient): Promise<Profile | null> {
  if (job.booking) return { email: job.booking.customerEmail, phone: job.booking.customerPhone, name: job.booking.customerName, smsConsent: job.booking.smsConsent || smsConsent };
  if (!job.wo?.customerId) return null;
  try {
    const c = await (client ?? new LightspeedClient(db)).getCustomer(job.wo.customerId);
    return c ? { email: c.email, phone: c.phone, name: c.name, smsConsent } : null;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), workorderId: job.workorderId }, "tracker: customer lookup failed");
    return null;
  }
}

export type TrackerSend = { url: string; told: "sent" | "failed" | "no_contact" };

/** Text the customer their tracker link (making it if needed). Safe to call again: it re-sends the same link. */
export async function sendTracker(db: Db, args: { showroom: ShowroomCtx; jobId: string; actor: string; smsConsent: boolean; client?: LightspeedClient; now?: Date }): Promise<TrackerSend> {
  const { showroom } = args;
  const job = await resolveJob(db, showroom, args.jobId);
  const profile = await jobProfile(db, job, args.smsConsent, args.client);
  const name = profile?.name ?? job.booking?.customerName ?? job.wo?.customerName ?? "";
  const { tracker, url } = await ensureTracker(db, { showroomId: showroom.id, workorderId: job.workorderId, customerName: name });
  let told: TrackerSend["told"] = "sent";
  if (!profile || (!profile.email && !profile.phone)) {
    told = "no_contact";
  } else {
    try {
      await getNotifier().send(
        CHECKED_IN_METRIC,
        profile,
        { customer_name: name, first_name: name.split(/\s+/)[0] ?? "", item: job.wo?.item || "", url, workorder_id: job.workorderId, showroom: showroom.name, showroom_phone: showroom.phone ?? "" },
        `${job.workorderId}:checked-in:${Date.now()}`,
      );
    } catch (err) {
      told = "failed";
      logger.warn({ err: err instanceof Error ? err.message : String(err), workorderId: job.workorderId }, "tracker link not sent");
    }
  }
  await db.update(jobTrackers).set({ toldStatus: told, toldAt: args.now ?? new Date() }).where(eq(jobTrackers.id, tracker.id));
  await db.insert(events).values({ showroomId: showroom.id, type: "tracker_sent", actor: args.actor, payload: { workorder_id: job.workorderId, booking_id: job.booking?.id ?? null, metric: CHECKED_IN_METRIC }, klaviyoStatus: told === "sent" ? "sent" : told === "failed" ? "failed" : null });
  return { url, told };
}
