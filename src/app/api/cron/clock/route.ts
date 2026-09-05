import type { NextRequest } from "next/server";
import { db } from "@/db/client";
import { runClock } from "@/lib/clock";
import { logger } from "@/lib/logger";

// Lightspeed syncs run inside this route (server actions / cron); Vercel Hobby caps requests at 10s by default, 60s allowed.
export const maxDuration = 60;

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}` || request.headers.get("x-cron-secret") === secret;
}

async function handle(request: NextRequest) {
  if (!authorized(request)) return new Response("Unauthorized", { status: 401 });
  const force = request.nextUrl.searchParams.get("force");
  try {
    const summaries = await runClock(db, {
      forceDaily: force === "daily" || force === "all",
      forceReminders: force === "reminders" || force === "all",
    });
    return Response.json({ ok: true, summaries });
  } catch (err) {
    logger.error({ err }, "clock run failed");
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

/** Vercel Cron calls GET with `Authorization: Bearer CRON_SECRET`; the spec's POST is also accepted. */
export const GET = handle;
export const POST = handle;
