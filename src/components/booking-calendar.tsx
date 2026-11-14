import Link from "next/link";
import type { ReactNode } from "react";
import type { TypeDay } from "@/lib/type-slots";
import { formatLongDateFromLocal, formatTime } from "@/lib/time";

/**
 * The Calendly-style picker: a panel about the appointment on the left, a month calendar with the open days
 * highlighted in the middle, and the chosen day's times on the right; one column on a phone. Pure server
 * markup: the month, day and time live in the URL (?month=&date=&time=), so it works without JavaScript and
 * inside the website embed. Picking a time shows "Next", which adds &confirm=1 for the page's own next step.
 */
export function BookingCalendar({
  days,
  tz,
  base,
  month,
  date,
  time,
  accent,
  info,
  zone,
}: {
  days: TypeDay[];
  tz: string;
  /** Page URL without month/date/time (may already have a query string). */
  base: string;
  month?: string;
  date?: string;
  time?: string;
  accent: string;
  info: ReactNode;
  /** "Pacific time" — shown under the calendar. */
  zone: string;
}) {
  const join = base.includes("?") ? "&" : "?";
  const open = new Map(days.map((d) => [d.date, d]));
  const first = days[0]?.date;
  // Like Calendly: with no day picked, open on the next day that has times, with its times showing. Only in
  // that day's month, so paging to another month doesn't jump back.
  const nextOpen = days.find((d) => d.slots.length > 0)?.date;
  const picked = date ?? (nextOpen && (!month || month === nextOpen.slice(0, 7)) ? nextOpen : undefined);
  const last = days.at(-1)?.date;
  const thisMonth = (date ?? nextOpen ?? first ?? new Date().toISOString().slice(0, 10)).slice(0, 7);
  const shown = month && /^\d{4}-\d{2}$/.test(month) ? month : thisMonth;
  const selected = picked ? open.get(picked) : undefined;
  const href = (q: Record<string, string | undefined>) => {
    const parts = Object.entries(q).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`);
    return parts.length ? `${base}${join}${parts.join("&")}` : base;
  };
  const prevMonth = shiftMonth(shown, -1);
  const nextMonth = shiftMonth(shown, 1);
  const canPrev = !!first && prevMonth >= first.slice(0, 7);
  const canNext = !!last && nextMonth <= last.slice(0, 7);
  const cells = monthCells(shown);

  return (
    // Columns follow the width of the card, not the window (container queries), so the calendar also lays out
    // properly inside a narrower staff page: three columns only when there is room for them.
    <div className="@container overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className={`grid ${selected ? "@4xl:grid-cols-[minmax(240px,300px)_minmax(0,1fr)_220px]" : "@3xl:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]"}`}>
        <div className={`border-b border-border p-6 ${selected ? "@4xl:border-b-0 @4xl:border-r" : "@3xl:border-b-0 @3xl:border-r"}`}>{info}</div>

        <div className="p-6">
          <h2 className="text-lg font-semibold">Select a date &amp; time</h2>
          {!days.length ? (
            <p className="mt-4 text-sm text-muted">No times are open right now. Please check back soon.</p>
          ) : (
            <>
              <div className="mt-4 flex items-center justify-center gap-6">
                {canPrev ? <Link href={href({ month: prevMonth })} aria-label="Previous month" className="rounded-full p-2 hover:bg-background">‹</Link> : <span className="p-2 text-muted opacity-40" aria-hidden="true">‹</span>}
                <span className="min-w-36 text-center font-medium">{monthLabel(shown)}</span>
                {canNext ? <Link href={href({ month: nextMonth })} aria-label="Next month" className="rounded-full p-2 hover:bg-background">›</Link> : <span className="p-2 text-muted opacity-40" aria-hidden="true">›</span>}
              </div>
              <div className="mx-auto mt-3 grid max-w-sm grid-cols-7 gap-y-2 text-center text-sm" role="grid" aria-label={monthLabel(shown)}>
                {["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((d) => <div key={d} className="text-[11px] font-medium text-muted">{d}</div>)}
                {cells.map((c, i) => {
                  if (!c) return <div key={`e${i}`} />;
                  const day = open.get(c);
                  const isSel = c === picked;
                  const n = Number(c.slice(8));
                  if (!day) return <div key={c} className="mx-auto flex h-10 w-10 items-center justify-center text-muted/60">{n}</div>;
                  return (
                    <Link
                      key={c}
                      href={href({ month: shown, date: c })}
                      aria-label={`${formatLongDateFromLocal(c)}, ${day.slots.length} times`}
                      aria-current={isSel ? "date" : undefined}
                      className="group relative mx-auto flex h-10 w-10 items-center justify-center rounded-full font-semibold"
                      style={{ color: isSel ? "#fff" : accent }}
                    >
                      <Wheel accent={accent} selected={isSel} />
                      <span className="relative">{n}</span>
                    </Link>
                  );
                })}
              </div>
            </>
          )}
          <p className="mt-6 text-xs text-muted">Times are shown in {zone}.</p>
        </div>

        {selected && (
          <div className="border-t border-border p-6 @4xl:border-l @4xl:border-t-0">
            <p className="mb-3 font-medium">{formatLongDateFromLocal(selected.date)}</p>
            <ul className="max-h-[420px] space-y-2 overflow-y-auto pr-1" aria-label="Available times">
              {selected.slots.map((s) => (
                <li key={s.time}>
                  {s.time === time ? (
                    <div className="grid grid-cols-2 gap-2">
                      <span className="flex h-11 items-center justify-center rounded-lg text-sm font-semibold text-white" style={{ background: "#475569" }}>{formatTime(s.startsAt, tz)}</span>
                      <Link href={href({ month: shown, date: selected.date, time: s.time, confirm: "1" })} className="flex h-11 items-center justify-center rounded-lg text-sm font-semibold text-white" style={{ background: accent }}>Next</Link>
                    </div>
                  ) : (
                    <Link href={href({ month: shown, date: selected.date, time: s.time })} className="flex h-11 items-center justify-center rounded-lg border text-sm font-semibold hover:border-2" style={{ borderColor: accent, color: accent }}>
                      {formatTime(s.startsAt, tz)}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/** The left panel: brand, who, what, how long, where. */
export function BookingInfo({ brand, title, durationMin, location, description, extra }: { brand: string; title: string; durationMin: number; location: string; description?: string; extra?: ReactNode }) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold uppercase tracking-widest text-accent">Biktrix</p>
      <p className="text-sm text-muted">{brand}</p>
      <h1 className="text-2xl font-bold leading-tight">{title}</h1>
      <p className="flex items-center gap-2 text-sm text-muted"><ClockIcon /> {durationMin} min</p>
      <p className="flex items-center gap-2 text-sm text-muted"><PlaceIcon /> {location}</p>
      {extra}
      {description && <p className="pt-2 text-sm">{description}</p>}
    </div>
  );
}

function ClockIcon() {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
}
function PlaceIcon() {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></svg>;
}

function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-CA", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Dates of the month as YYYY-MM-DD, with nulls before the 1st so the grid starts on Sunday. */
export function monthCells(ym: string): (string | null)[] {
  const [y, m] = ym.split("-").map(Number);
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [...Array<null>(lead).fill(null), ...Array.from({ length: count }, (_, i) => `${ym}-${String(i + 1).padStart(2, "0")}`)];
}


/**
 * An open day drawn as a bike wheel (tyre, spokes, hub) in the booking type's colour; the date sits in the
 * hub. The chosen day is the same wheel filled in. Spokes turn a little on hover, unless motion is reduced.
 */
function Wheel({ accent, selected }: { accent: string; selected: boolean }) {
  // A bike wheel side-on: thin black tyre, a fine rim, spokes running in to the hub, and the hub (in the type's
  // colour) where the date sits. The picked day gets a solid hub; the others a light one. Spokes turn on hover.
  const hub = selected ? accent : `color-mix(in srgb, ${accent} 14%, white)`;
  const spoke = `color-mix(in srgb, ${accent} 45%, white)`;
  return (
    <svg aria-hidden="true" viewBox="0 0 40 40" className="absolute inset-0 h-full w-full">
      <circle cx="20" cy="20" r="18.4" fill="none" stroke="#17181a" strokeWidth="2.6" />
      <circle cx="20" cy="20" r="16.4" fill="none" stroke="#a8a29e" strokeWidth="0.8" />
      <g stroke={spoke} strokeWidth="0.6" className="origin-center transition-transform duration-500 motion-safe:group-hover:rotate-45" style={{ transformBox: "fill-box" }}>
        {WHEEL_SPOKES.map(([hubAt, rimAt]) => {
          const h = (hubAt * Math.PI) / 180, r = (rimAt * Math.PI) / 180;
          return <line key={hubAt} x1={20 + 11.5 * Math.cos(h)} y1={20 + 11.5 * Math.sin(h)} x2={20 + 16 * Math.cos(r)} y2={20 + 16 * Math.sin(r)} />;
        })}
      </g>
      <circle cx="20" cy="20" r="11.5" fill={hub} stroke={selected ? "none" : spoke} strokeWidth="0.6" />
    </svg>
  );
}

/** 12 spokes laced like a real wheel: each leaves the hub and meets the rim further round, alternate ones leaning opposite ways. [hub angle, rim angle] */
const WHEEL_SPOKES = Array.from({ length: 12 }, (_, i) => [i * 30, i * 30 + (i % 2 ? 10 : -10)] as const);
