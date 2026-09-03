import { sql } from "drizzle-orm";
import { db } from "@/db/client";

export async function GET() {
  const checks: Record<string, boolean> = { klaviyo_key: !!process.env.KLAVIYO_PRIVATE_KEY, cron_secret: !!process.env.CRON_SECRET };
  try {
    await db.execute(sql`select 1`);
    checks.database = true;
  } catch {
    checks.database = false;
  }
  const ok = checks.database;
  return Response.json({ ok, checks, time: new Date().toISOString() }, { status: ok ? 200 : 503 });
}
