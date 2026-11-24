/**
 * The bike's condition when it comes in (the showrooms' list): odometer, chain wear, bearing play, key, brakes and
 * brake pads. Taken at the counter on New ticket or at Check in on the job page, so the scope of work is assessed
 * and on record before anyone starts. Every field is optional; a field not answered stays blank.
 */
export const INTAKE_FIELDS = [
  { key: "chain", label: "Chain wear", options: { ok: "Under 0.5%", p05: "0.5%", p075: "0.75%", p1: "1%+" }, short: { ok: "<0.5%" } },
  { key: "bearings", label: "Bearing play", options: { none: "None", play: "Play" } },
  { key: "key", label: "Key", options: { not_needed: "Not needed", with_bike: "With bike", kept: "Customer kept" }, short: { not_needed: "None", kept: "Kept" } },
  { key: "brakes", label: "Brakes", options: { ok: "Good", adjust: "Adjust", bleed: "Bleed" } },
  { key: "pads", label: "Brake pads", options: { ok: "Good", low: "Low", replace: "Replace" } },
] as const;

export type IntakeKey = (typeof INTAKE_FIELDS)[number]["key"];
export type Intake = { odometer: number | null } & Partial<Record<IntakeKey, string>>;

/** The answers a form sent (odometer and intake_<field>); null when nothing was filled in. */
export function intakeFromForm(get: (name: string) => string): Intake | null {
  const km = get("intake_odometer").replace(/[^\d.]/g, "");
  const n = km ? Math.round(Number(km)) : NaN;
  const out: Intake = { odometer: Number.isFinite(n) && n >= 0 && n < 1_000_000 ? n : null };
  for (const f of INTAKE_FIELDS) {
    const v = get(`intake_${f.key}`);
    if (v && Object.hasOwn(f.options, v)) out[f.key] = v;
  }
  return isEmptyIntake(out) ? null : out;
}

export function isEmptyIntake(i: Intake | null | undefined): boolean {
  return !i || (i.odometer === null && INTAKE_FIELDS.every((f) => !i[f.key]));
}

/** What each answer reads as: [["Odometer", "1,240 km"], ["Chain wear", "0.75%"], …], answered ones only. */
export function intakeRows(i: Intake | null | undefined): [string, string][] {
  if (!i) return [];
  const rows: [string, string][] = [];
  if (i.odometer !== null) rows.push(["Odometer", `${i.odometer.toLocaleString("en-CA")} km`]);
  for (const f of INTAKE_FIELDS) {
    const v = i[f.key];
    const text = v ? (f.options as Record<string, string>)[v] : undefined;
    if (text) rows.push([f.label, text]);
  }
  return rows;
}

/** One line for the Lightspeed note: "Odometer 1,240 km · Chain wear 0.75% · Brakes Bleed". */
export function intakeSummary(i: Intake | null | undefined): string {
  return intakeRows(i).map(([k, v]) => `${k} ${v}`).join(" · ");
}
