/** Shown while a booking page loads (streamed first, so the frame appears at once): the calendar's shape, pulsing. */
export function BookingSkeleton() {
  const bar = (w: string, h = "h-3") => <div className={`${h} rounded bg-border`} style={{ width: w }} />;
  return (
    <div role="status" aria-label="Loading available times" className="space-y-4">
      <div className="h-4 w-40" />
      <div className="animate-pulse overflow-hidden rounded-2xl border border-border bg-card shadow-sm lg:grid lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
        <div className="space-y-3 border-b border-border p-6 lg:border-b-0 lg:border-r">
          {bar("30%")}{bar("50%")}{bar("85%", "h-7")}{bar("40%")}{bar("60%")}
        </div>
        <div className="p-6">
          {bar("45%", "h-5")}
          <div className="mx-auto mt-8 grid max-w-sm grid-cols-7 gap-y-3">
            {Array.from({ length: 35 }, (_, i) => (
              <span key={i} className={`mx-auto h-9 w-9 rounded-full ${i % 7 > 0 && i % 7 < 6 && i > 8 ? "bg-accent-soft" : "bg-background"}`} />
            ))}
          </div>
          <p className="mt-6 text-sm text-muted">Loading available times…</p>
        </div>
      </div>
    </div>
  );
}
