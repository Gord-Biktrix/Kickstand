import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { baseUrl } from "@/lib/messages";

export async function GET() {
  const checks: Record<string, boolean> = { klaviyo_key: !!process.env.KLAVIYO_PRIVATE_KEY, cron_secret: !!process.env.CRON_SECRET };
  try {
    await db.execute(sql`select 1`);
    checks.database = true;
  } catch {
    checks.database = false;
  }
  const ok = checks.database;
  // Customer links are built from this; a blank APP_BASE_URL once shipped texts with bare "/b/…" paths.
  const base_url = baseUrl();
  checks.base_url = /^https:\/\//.test(base_url);
  return Response.json({ ok, checks, base_url, time: new Date().toISOString() }, { status: ok ? 200 : 503 });
}
