import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local" });
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { capacityRules, showrooms } from "../src/db/schema";
import { DEFAULT_SETTINGS } from "../src/lib/settings";

/**
 * Add (or update) a showroom so a second store can run the program.
 *
 *   ENV_FILE=.env.production pnpm showroom:add --slug saskatoon --name "Biktrix Saskatoon" \
 *     --tz America/Regina --address "123 Example St, Saskatoon, SK S7K 0A1" --phone "306-555-0100" \
 *     --shop 4 --employee 12 [--copy-capacity-from vancouver]
 *
 * --shop / --employee are the Lightspeed shop and employee ids for that store (whoami in scripts/ls-poc.mjs
 * lists them). Capacity rules start as a copy of another showroom's (default vancouver) — adjust in
 * Settings › Capacity. The Lightspeed bridge starts disabled for the new store; run ls:setup --showroom <slug>.
 */
function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const db = createDb(process.env.DATABASE_URL!);
  const slug = arg("slug"); const name = arg("name"); const tz = arg("tz");
  if (!slug || !name || !tz) throw new Error("usage: showroom:add --slug <slug> --name <name> --tz <IANA tz> [--address …] [--phone …] [--shop <id>] [--employee <id>] [--copy-capacity-from vancouver]");
  const shop = arg("shop"); const employee = arg("employee");
  const settings = {
    ...DEFAULT_SETTINGS,
    lightspeed: { ...DEFAULT_SETTINGS.lightspeed, enabled: false, shop_id: shop ? Number(shop) : null, employee_id: employee ? Number(employee) : null },
  };
  const [row] = await db
    .insert(showrooms)
    .values({ slug, name, timezone: tz, addressLine: arg("address", "") ?? "", phone: arg("phone") ?? null, settings })
    .onConflictDoUpdate({ target: showrooms.slug, set: { name, timezone: tz, ...(arg("address") ? { addressLine: arg("address")! } : {}), ...(arg("phone") ? { phone: arg("phone")! } : {}) } })
    .returning();
  const from = arg("copy-capacity-from", "vancouver")!;
  const [src] = await db.select().from(showrooms).where(eq(showrooms.slug, from));
  const existing = await db.select().from(capacityRules).where(eq(capacityRules.showroomId, row.id));
  if (src && existing.length === 0) {
    const rules = await db.select().from(capacityRules).where(eq(capacityRules.showroomId, src.id));
    for (const r of rules) {
      await db.insert(capacityRules).values({ showroomId: row.id, weekday: r.weekday, capacity: r.capacity, windowStart: r.windowStart, windowEnd: r.windowEnd, maxConcurrent: r.maxConcurrent }).onConflictDoNothing();
    }
    console.log(`Copied ${rules.length} capacity rules from ${from}`);
  }
  console.log(`Showroom ${row.slug} (${row.id}) — ${row.name}, ${row.timezone}; Lightspeed shop ${shop ?? "unset"}, employee ${employee ?? "unset"}, bridge disabled.`);
  console.log(`Next: ENV_FILE=… pnpm ls:setup --showroom ${row.slug} --shop ${shop ?? "<id>"} --employee ${employee ?? "<id>"} …`);
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
