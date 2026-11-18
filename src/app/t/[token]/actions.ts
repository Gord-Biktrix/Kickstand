"use server";

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { findings, lsWorkorders } from "@/db/schema";
import { answerFindings, changeToYes } from "@/lib/findings";
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

/** "Changed your mind? Fix it": a finding they said no to becomes a yes, while the bike isn't ready yet. */
export async function changeMindAction(token: string, findingId: string) {
  const back = `/t/${encodeURIComponent(token)}`;
  const tracker = await trackerByToken(db, token);
  if (!tracker) redirect(back);
  if (deriveTrack(await loadJobLog(db, tracker.workorderId), new Date()).step === "pickup") redirect(`${back}?error=ready#found`);
  const [wo] = await db.select({ employeeId: lsWorkorders.employeeId }).from(lsWorkorders).where(eq(lsWorkorders.id, tracker.workorderId));
  await changeToYes(db, { findingId, workorderId: tracker.workorderId, by: "customer", employeeId: wo?.employeeId ?? null });
  redirect(`${back}?answered=1#found`);
}
