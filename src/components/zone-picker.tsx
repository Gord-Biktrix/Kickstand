"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** Point the page at another zone: drops the picked day and time, which are labelled in the old zone. */
function zoneUrl(tz: string, keepSelection = false): string {
  const url = new URL(window.location.href);
  url.searchParams.set("tz", tz);
  if (!keepSelection) {
    url.searchParams.delete("date");
    url.searchParams.delete("time");
    url.searchParams.delete("confirm");
  }
  return url.pathname + url.search;
}

/**
 * On a customer's first visit, switch the page to their browser's time zone (adds ?tz=, once). Does nothing when
 * the URL already names a zone (their own choice, or a link that carries it) or the browser is in the store's zone.
 */
export function useAutoZone(storeTz: string, keepSelection = false) {
  const router = useRouter();
  useEffect(() => {
    if (new URL(window.location.href).searchParams.has("tz")) return;
    let detected = "";
    try {
      detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {}
    if (!detected || detected === storeTz) return;
    router.replace(zoneUrl(detected, keepSelection), { scroll: false });
  }, [router, storeTz, keepSelection]);
}

/** For pages that only show times (the manage page): switch to the customer's zone, no picker. */
export function ZoneAuto({ storeTz }: { storeTz: string }) {
  useAutoZone(storeTz, true);
  return null;
}

type ZoneRow = { tz: string; offset: string; minutes: number; abbr: string; label: string; now: string };

/** "GMT-08:00", minutes east of UTC, and "PST" (or "GMT-12" where there's no common abbreviation). */
function describe(tz: string, at: Date): ZoneRow | null {
  try {
    const long = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(long);
    const minutes = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
    const offset = m ? `GMT${m[1]}${m[2]}:${m[3]}` : "GMT+00:00";
    const short = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
    const abbr = /^GMT[+-]?\d*/.test(short) || !short ? (m ? `GMT${m[1]}${Number(m[2])}${m[3] !== "00" ? `:${m[3]}` : ""}` : "GMT") : short;
    const now = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(at);
    return { tz, offset, minutes, abbr, label: `${offset} ${tz} (${abbr})`, now };
  } catch {
    return null;
  }
}

function allZones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    if (list?.length) return list;
  } catch {}
  return ["America/Vancouver", "America/Edmonton", "America/Regina", "America/Winnipeg", "America/Toronto", "America/Halifax", "America/St_Johns", "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Australia/Sydney"];
}

/**
 * The time zone control under the calendar, like YouCanBookMe's: "🌐 GMT-08:00 America/Vancouver (PST) ▾",
 * opening a list of every zone sorted by offset with the current time in each, and a search box. Detects the
 * customer's own zone on first visit.
 */
export function ZonePicker({ current, storeTz }: { current: string; storeTz: string }) {
  const router = useRouter();
  useAutoZone(storeTz);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => new Date());
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const selectedRow = useRef<HTMLLIElement>(null);

  const rows = useMemo(() => {
    if (!open) return [];
    return allZones()
      .map((tz) => describe(tz, now))
      .filter((r): r is ZoneRow => !!r)
      .sort((a, b) => a.minutes - b.minutes || a.tz.localeCompare(b.tz));
  }, [open, now]);
  const q = query.trim().toLowerCase().replace(/\s+/g, "_");
  const shown = q ? rows.filter((r) => r.label.toLowerCase().includes(q) || r.label.toLowerCase().replace(/_/g, " ").includes(query.trim().toLowerCase())) : rows;
  const currentRow = describe(current, now);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    selectedRow.current?.scrollIntoView({ block: "center" });
    const outside = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", esc); };
  }, [open]);

  function pick(tz: string) {
    setOpen(false);
    setQuery("");
    if (tz !== current) router.replace(zoneUrl(tz), { scroll: false });
  }

  return (
    <div ref={box} className="relative">
      <p className="mb-1 text-sm font-semibold text-foreground">Time zone</p>
      <button type="button" onClick={() => { setNow(new Date()); setOpen((o) => !o); }} aria-haspopup="listbox" aria-expanded={open} className="flex w-full items-center gap-2 rounded-md py-1.5 text-left text-sm text-foreground hover:bg-background">
        <GlobeIcon />
        <span className="min-w-0 flex-1 truncate" suppressHydrationWarning>{currentRow?.label ?? current}</span>
        <span aria-hidden="true" className="text-accent">▾</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 right-0 z-20 mb-1 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
          <ul role="listbox" aria-label="Time zones" className="max-h-64 overflow-y-auto p-1.5">
            {shown.map((r) => {
              const sel = r.tz === current;
              return (
                <li key={r.tz} ref={sel ? selectedRow : undefined} role="option" aria-selected={sel}>
                  <button type="button" onClick={() => pick(r.tz)} className={`flex w-full items-start justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm ${sel ? "bg-accent-soft font-medium" : "hover:bg-background"}`}>
                    <span className="min-w-0 break-words">{r.label}</span>
                    <span className="shrink-0 tabular-nums text-muted" suppressHydrationWarning>{r.now}</span>
                  </button>
                </li>
              );
            })}
            {shown.length === 0 && <li className="px-3 py-2 text-sm text-muted">No time zone matches “{query}”.</li>}
          </ul>
          <div className="border-t border-border p-2">
            <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type here to search time zones" aria-label="Search time zones" className="w-full rounded-full bg-background px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-accent" />
          </div>
        </div>
      )}
    </div>
  );
}

function GlobeIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="shrink-0 text-muted">
      <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
    </svg>
  );
}
