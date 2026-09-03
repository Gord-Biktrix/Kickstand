export type SearchParams = Record<string, string | string[] | undefined>;

export function sp(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function withFlash(path: string, flash: { ok?: string; error?: string }): string {
  const u = new URLSearchParams();
  if (flash.ok) u.set("ok", flash.ok);
  if (flash.error) u.set("error", flash.error);
  const qs = u.toString();
  if (!qs) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${qs}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export function num(formData: FormData, key: string, fallback = 0): number {
  const v = str(formData, key);
  if (v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Dollars typed by staff → integer cents. */
export function dollarsToCents(formData: FormData, key: string): number {
  const v = str(formData, key).replace(/[$,\s]/g, "");
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function bool(formData: FormData, key: string): boolean {
  const v = formData.get(key);
  return v === "on" || v === "true" || v === "1";
}
