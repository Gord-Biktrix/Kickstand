/** Kickstand mark + wordmark (docs/brand). The K's leg is the kickstand: stem floats, leg touches the baseline. */

const PATHS = (
  <>
    <path d="M18 12V42" /><path d="M18 32L40 12" /><path d="M26 25L46 52" /><path d="M12 52H52" />
  </>
);

/** Orange rounded tile with the mark in paper white. */
export function KickstandMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className={className} style={{ display: "block", flexShrink: 0 }}>
      <rect width="64" height="64" rx="14" fill="#C2410C" />
      <g fill="none" stroke="#FAFAFA" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" transform="translate(32 32) scale(0.78) translate(-32 -32)">
        {PATHS}
      </g>
    </svg>
  );
}

/** Tile + "Kickstand" wordmark. `size` is the tile height; the wordmark scales with it. */
export function KickstandLogo({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center ${className}`} style={{ gap: size * 0.32 }}>
      <KickstandMark size={size} />
      <span className="font-semibold text-foreground" style={{ fontSize: size * 0.86, letterSpacing: "-0.025em", lineHeight: 1 }}>Kickstand</span>
    </span>
  );
}
