import { LEVELS, type Level } from "@/lib/finding-levels";

/** How strongly the mechanic recommends a finding: 1–3 rising bars and the level in condensed caps. */
export function LevelMeter({ level, size = "md" }: { level: Level; size?: "sm" | "md" }) {
  const h = size === "sm" ? [6, 10, 14] : [8, 13, 18];
  return (
    <span role="img" aria-label={LEVELS[level].label} className="inline-flex items-center gap-2 text-[#015d47]">
      <span aria-hidden className="inline-flex items-end gap-[3px]" style={{ height: h[2] }}>
        {h.map((px, i) => <i key={i} className={`block w-1.5 rounded-[1px] ${i < level ? "bg-[#015d47]" : "bg-[#d9d5ce]"}`} style={{ height: px }} />)}
      </span>
      <span className={`font-condensed font-extrabold tracking-[.04em] uppercase ${size === "sm" ? "text-sm" : "text-[17px]"}`}>{LEVELS[level].label}</span>
    </span>
  );
}
