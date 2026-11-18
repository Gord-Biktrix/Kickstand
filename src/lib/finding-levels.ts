/** How strongly a mechanic recommends a finding (safe to import in client components). */
export const LEVELS = {
  1: { label: "Suggested", note: "Nice to have; fine to leave for now" },
  2: { label: "Recommended", note: "Should be done soon; it's wearing out" },
  3: { label: "Highly recommended", note: "May pose a safety risk if left" },
} as const;
export type Level = keyof typeof LEVELS;
export const isLevel = (n: number): n is Level => n === 1 || n === 2 || n === 3;
