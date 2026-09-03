import { config } from "dotenv";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "../src/db/client";

config({ path: process.env.ENV_FILE ?? ".env.local" });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const db = createDb(url);
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log(`Migrated ${url.replace(/\/\/.*@/, "//***@")}`);
  await db.$client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
