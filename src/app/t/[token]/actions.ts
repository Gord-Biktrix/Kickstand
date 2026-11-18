"use server";

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { findings, lsWorkorders } from "@/db/schema";
import { answerFindings, changeAnswer } from "@/lib/findings";
import { loadJobLog } from "@/lib/job-log";
import { deriveTrack } from "@/lib/job-track";
import { trackerByToken } from "@/lib/tracker";

/**
 * The customer answers what was found, right on their tracker: "d:<finding id>" = "yes" | "no". Only findings sent
 * to them and not yet answered change; each request's answers are recorded together.
 */
export async function answerOnTrackerAction(token: string, formData: FormData) {
  const back = `/t/${encodeURIComponent(token)}`;
  const tracker = await trackerByToken(db, token);
  if (!tracker) redirect(back);
  const open = await db.select().from(findings).where(and(eq(findings.workorderId, tracker.workorderId), isNotNull(findings.requestId), isNull(findings.decision)));
  const byRequest = new Map<string, Record<string, "approved" | "declined">>();
  for (const f of open) {
    const v = formData.get(`d:${f.id}`);
    if (v !== "yes" && v !== "no") continue;
    const m = byRequest.get(f.requestId!) ?? {};
    m[f.id] = v === "yes" ? "approved" : "declined";
    byRequest.set(f.requestId!, m);
  }
  if (!byRequest.size) redirect(`${back}?error=pick#found`);
  const [wo] = await db.select({ employeeId: lsWorkorders.employeeId }).from(lsWorkorders).where(eq(lsWorkorders.id, tracker.workorderId));
  for (const [requestId, decisions] of byRequest) await answerFindings(db, { requestId, decisions, by: "customer", employeeId: wo?.employeeId ?? null });
  redirect(`${back}?answered=1#found`);
}

/** "Changed your mind?" on an answered finding, after they confirm on the page: no → yes, or yes → no, while it isn't ready. */
export async function changeMindAction(token: string, findingId: string, to: "approved" | "declined") {
  const back = `/t/${encodeURIComponent(token)}`;
  const tracker = await trackerByToken(db, token);
  if (!tracker) redirect(back);
  if (deriveTrack(await loadJobLog(db, tracker.workorderId), new Date()).step === "pickup") redirect(`${back}?error=ready#answers`);
  const [wo] = await db.select({ employeeId: lsWorkorders.employeeId }).from(lsWorkorders).where(eq(lsWorkorders.id, tracker.workorderId));
  await changeAnswer(db, { findingId, workorderId: tracker.workorderId, to, by: "customer", employeeId: wo?.employeeId ?? null });
  redirect(`${back}?changed=${to === "approved" ? "yes" : "no"}#answers`);
}
