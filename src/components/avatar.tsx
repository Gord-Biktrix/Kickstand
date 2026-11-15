/** A round staff photo, or their initial when there's none. Plain <img>: tiny, already sized, served cached. */
export function Avatar({ name, photo, size = 40, className = "" }: { name: string; photo: string | null | undefined; size?: number; className?: string }) {
  const style = { width: size, height: size };
  if (photo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={photo} alt="" width={size} height={size} style={style} className={`shrink-0 rounded-full object-cover ${className}`} />;
  }
  return (
    <span aria-hidden="true" style={{ ...style, fontSize: Math.round(size * 0.4) }} className={`flex shrink-0 items-center justify-center rounded-full bg-background font-semibold text-muted ${className}`}>
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
