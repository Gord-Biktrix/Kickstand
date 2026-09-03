import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDb(url: string) {
  const sql = postgres(url, { max: 10, prepare: false, onnotice: () => {} });
  return drizzle(sql, { schema, casing: "snake_case" });
}

export type Db = ReturnType<typeof createDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

const globalForDb = globalThis as unknown as { __pickupDb?: Db };

export const db: Db =
  globalForDb.__pickupDb ??
  createDb(process.env.DATABASE_URL ?? "postgres://localhost:5432/pickup_dev");

if (process.env.NODE_ENV !== "production") globalForDb.__pickupDb = db;
