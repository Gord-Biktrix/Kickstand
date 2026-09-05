import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local" });
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { showrooms, staffUsers } from "../src/db/schema";

/**
 * Add or update a staff account.
 *
 *   ENV_FILE=.env.production pnpm staff:add --email sam@biktrix.com --name "Sam Lee" --role staff --showroom vancouver
 *   … --role manager --showroom all        (managers/admins may switch stores; "all" = no home store)
 *   … --deactivate                         (keeps history, blocks sign-in)
 *
 * The email must also pass the allow-list (AUTH_ALLOWED_DOMAIN / AUTH_ALLOWED_EMAILS) before the
 * magic link is issued. Give every manager and staff member a --showroom; only admins should use "all".
 */
function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const db = createDb(process.env.DATABASE_URL!);
  const email = arg("email")?.trim().toLowerCase();
  if (!email) throw new Error("usage: staff:add --email <email> --name <name> --role staff|manager|admin --showroom <slug|all> [--deactivate]");
  const role = (arg("role", "staff") as "staff" | "manager" | "admin");
  if (!["staff", "manager", "admin"].includes(role)) throw new Error("role must be staff, manager or admin");
  const slug = arg("showroom", "all")!;
  let showroomId: string | null = null;
  if (slug !== "all") {
    const [s] = await db.select().from(showrooms).where(eq(showrooms.slug, slug));
    if (!s) throw new Error(`Showroom '${slug}' not found`);
    showroomId = s.id;
  }
  const active = !process.argv.includes("--deactivate");
  const name = arg("name") ?? email.split("@")[0];
  const [row] = await db
    .insert(staffUsers)
    .values({ email, name, role, showroomId, active })
    .onConflictDoUpdate({ target: staffUsers.email, set: { name, role, showroomId, active } })
    .returning();
  console.log(`${active ? "Active" : "Deactivated"} ${row.role} ${row.email} (${row.name}) — showroom ${slug}`);
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
