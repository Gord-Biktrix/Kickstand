import { asc, eq, gte, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/db/client";
import {
  capacityOverrides,
  capacityRules,
  showrooms,
  type CapacityOverride,
  type CapacityRule,
  type Showroom,
} from "@/db/schema";
import { parseSettings, type ProgramSettings } from "./settings";

export type ShowroomCtx = Omit<Showroom, "settings"> & {
  settings: ProgramSettings;
  rawSettings: Record<string, unknown>;
};

function toCtx(row: Showroom): ShowroomCtx {
  return { ...row, settings: parseSettings(row.settings), rawSettings: row.settings };
}

export async function getShowroom(
  dbx: DbOrTx = db,
  slug = process.env.DEFAULT_SHOWROOM ?? "vancouver",
): Promise<ShowroomCtx> {
  const [row] = await dbx.select().from(showrooms).where(eq(showrooms.slug, slug)).limit(1);
  if (!row) throw new Error(`Showroom '${slug}' not found — run the seed`);
  return toCtx(row);
}

export async function getShowroomById(dbx: DbOrTx, id: string): Promise<ShowroomCtx> {
  const [row] = await dbx.select().from(showrooms).where(eq(showrooms.id, id)).limit(1);
  if (!row) throw new Error("Showroom not found");
  return toCtx(row);
}

export async function listShowrooms(dbx: DbOrTx = db): Promise<ShowroomCtx[]> {
  const rows = await dbx.select().from(showrooms).orderBy(asc(showrooms.slug));
  return rows.map(toCtx);
}

export type CapacityConfig = { rules: CapacityRule[]; overrides: CapacityOverride[] };

export async function getCapacityConfig(
  dbx: DbOrTx,
  showroomId: string,
  fromDate?: string,
): Promise<CapacityConfig> {
  const rules = await dbx
    .select()
    .from(capacityRules)
    .where(eq(capacityRules.showroomId, showroomId))
    .orderBy(asc(capacityRules.weekday));
  const overrides = await dbx
    .select()
    .from(capacityOverrides)
    .where(
      fromDate
        ? sql`${capacityOverrides.showroomId} = ${showroomId} and ${gte(capacityOverrides.onDate, fromDate)}`
        : eq(capacityOverrides.showroomId, showroomId),
    )
    .orderBy(asc(capacityOverrides.onDate));
  return { rules, overrides };
}

/** Shallow-merge a settings patch into showrooms.settings (JSONB ||). */
export async function patchShowroomSettings(
  dbx: DbOrTx,
  showroomId: string,
  patch: Partial<ProgramSettings>,
): Promise<void> {
  await dbx
    .update(showrooms)
    .set({ settings: sql`${showrooms.settings} || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(showrooms.id, showroomId));
}
