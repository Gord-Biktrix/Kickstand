/**
 * Which Lightspeed work-order statuses sit in which Workshop column. Each store can set this in
 * Settings › Views; until it does, the defaults are worked out from the status names (Vancouver's list,
 * 2026-11: "Open", "Appointment", "Parts On Order", "Finished"…). Statuses in no column stay off the board:
 * estimates (not agreed yet), paid, shop inventory.
 */
import type { ProgramSettings } from "./settings";

export type BoardColumn = "todo" | "doing" | "parts" | "ready";
export type WorkshopColumns = Record<BoardColumn, number[]>;

export const BOARD_COLUMNS: { key: BoardColumn; label: string }[] = [
  { key: "todo", label: "To do" },
  { key: "doing", label: "In progress" },
  { key: "parts", label: "Waiting on parts" },
  { key: "ready", label: "Ready" },
];

type StatusLike = { id: number; name: string; systemValue: string | null; archived?: boolean };

/** Name rules, checked in order: the first that matches wins. Null = off the board. */
const RULES: [RegExp, BoardColumn | null][] = [
  [/paid|inventory|estimate|^waiting$|not ready/i, null],
  [/parts arrived|next in the queue/i, "todo"],
  [/part|warranty|waiting for/i, "parts"],
  [/finished|ready for pick|ready to ship|^ready|ready$/i, "ready"],
  [/in progress|testing|test ride|qc/i, "doing"],
  [/open|appointment|build|repair|diagnos|urgent|priority|queue|scheduled/i, "todo"],
];

export function defaultColumnFor(s: StatusLike): BoardColumn | null {
  if (s.systemValue === "paid") return null;
  if (s.systemValue === "open") return "todo";
  if (s.systemValue === "finished") return "ready";
  for (const [re, col] of RULES) if (re.test(s.name.trim())) return col;
  return null;
}

export function defaultWorkshopColumns(statuses: StatusLike[]): WorkshopColumns {
  const out: WorkshopColumns = { todo: [], doing: [], parts: [], ready: [] };
  for (const s of statuses) {
    if (s.archived) continue;
    const col = defaultColumnFor(s);
    if (col) out[col].push(s.id);
  }
  return out;
}

/** The store's mapping, or the defaults. */
export function workshopColumns(settings: Pick<ProgramSettings, "workshop_columns">, statuses: StatusLike[]): WorkshopColumns {
  return settings.workshop_columns ?? defaultWorkshopColumns(statuses);
}

export function columnOf(columns: WorkshopColumns, statusId: number): BoardColumn | null {
  for (const { key } of BOARD_COLUMNS) if (columns[key].includes(statusId)) return key;
  return null;
}
