"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { lsWorkorders } from "@/db/schema";
import { answerFindings, requestByToken } from "@/lib/findings";

/** The customer's answers from their link: "d:<finding id>" = "yes" | "no". Already-answered findings don't change. */
export async function confirmFindingsAction(token: string, formData: FormData) {
  const found = await requestByToken(db, token);
  if (!found) redirect(`/ok/${encodeURIComponent(token)}`);
  const decisions: Record<string, "approved" | "declined"> = {};
  for (const f of found.findings) {
    const v = formData.get(`d:${f.id}`);
    if (v === "yes") decisions[f.id] = "approved";
    else if (v === "no") decisions[f.id] = "declined";
  }
  if (!Object.keys(decisions).length) redirect(`/ok/${encodeURIComponent(token)}?error=pick`);
  const [wo] = await db.select({ employeeId: lsWorkorders.employeeId }).from(lsWorkorders).where(eq(lsWorkorders.id, found.request.workorderId));
  await answerFindings(db, { requestId: found.request.id, decisions, by: "customer", employeeId: wo?.employeeId ?? null });
  redirect(`/ok/${encodeURIComponent(token)}`);
}
