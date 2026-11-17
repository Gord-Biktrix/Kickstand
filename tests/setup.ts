import { config } from "dotenv";

// override: tests truncate tables, so never run against a DATABASE_URL already in the shell (e.g. .env.local's).
config({ path: ".env.test", override: true });
if (!/pickup_test/.test(process.env.DATABASE_URL ?? "")) throw new Error("Tests only run against the pickup_test database.");
