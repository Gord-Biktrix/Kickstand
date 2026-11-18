"use client";

import Link from "next/link";
import { useState, type MouseEvent, type ReactNode } from "react";
import { formatLongDateFromLocal } from "@/lib/time";

/** A day's open times with their labels already formatted on the server (see BookingCalendar). */
export type PickerDay = { date: string; slots: { time: string; label: string }[] };

/**
 * The Calendly-style picker: a panel about the appointment on the left, a month calendar with the open days
 * highlighted in the middle, and the chosen day's times on the right; one column on a phone. Pure server
 * The month, day and time live in the URL (?month=&date=&time=) so links and the no-JavaScript page work, but
 * with JavaScript a click changes them right here and just rewrites the URL: every day's times are already on
 * the page, so asking the server again on each click only added lag. "Next" (adds &confirm=1) is a real
 * navigation to the page's own next step.
 */
export function BookingCalendarPicker({
  days,
  base,
  month: urlMonth,
  date: urlDate,
  time: urlTime,
  accent,
  info,
  zone,
}: {
  days: PickerDay[];
  /** Page URL without month/date/time (may already have a query string). */
  base: string;
  month?: string;
  date?: string;
  time?: string;
  accent: string;
  info: ReactNode;
  /** "Pacific time" (shown as "Times are shown in …"), or a zone picker. */
  zone: ReactNode;
}) {
  // What the URL says, then whatever the customer clicks since; reset when the server sends new props (a new
  // zone, the back button).
  const fromProps = `${urlMonth}|${urlDate}|${urlTime}|${base}`;
  const [seen, setSeen] = useState(fromProps);
  const [pick, setPick] = useState<{ month?: string; date?: string; time?: string }>({ month: urlMonth, date: urlDate, time: urlTime });
  if (seen !== fromProps) {
    setSeen(fromProps);
    setPick({ month: urlMonth, date: urlDate, time: urlTime });
  }
  const { month, date, time } = pick;
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
  /** Left-click on a calendar link: change it here and rewrite the URL, no trip to the server. */
  const go = (q: { month?: string; date?: string; time?: string }) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    setPick(q);
    window.history.replaceState(window.history.state, "", href(q));
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
      {/* The info column stays put whether or not a day is picked (no jump): the times join as a third column when
          there's room, else they sit under the calendar in the same column. */}
      <div className={`grid @3xl:min-h-[540px] @3xl:grid-cols-[minmax(240px,300px)_minmax(0,1fr)] ${selected ? "@4xl:grid-cols-[minmax(240px,300px)_minmax(0,1fr)_220px]" : ""}`}>
        <div className="border-b border-border p-6 @3xl:row-span-2 @3xl:border-b-0 @3xl:border-r @4xl:row-span-1">{info}</div>

        <div className="p-6">
          <h2 className="text-lg font-semibold">Select a date &amp; time</h2>
          {!days.length ? (
            <p className="mt-4 text-sm text-muted">No times are open right now. Please check back soon.</p>
          ) : (
            <>
              <div className="mt-4 flex items-center justify-center gap-6">
                {canPrev ? <a href={href({ month: prevMonth })} onClick={go({ month: prevMonth })} aria-label="Previous month" className="rounded-full p-2 hover:bg-background">‹</a> : <span className="p-2 text-muted opacity-40" aria-hidden="true">‹</span>}
                <span className="min-w-36 text-center font-medium">{monthLabel(shown)}</span>
                {canNext ? <a href={href({ month: nextMonth })} onClick={go({ month: nextMonth })} aria-label="Next month" className="rounded-full p-2 hover:bg-background">›</a> : <span className="p-2 text-muted opacity-40" aria-hidden="true">›</span>}
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
                    <a
                      key={c}
                      href={href({ month: shown, date: c })}
                      onClick={go({ month: shown, date: c })}
                      aria-label={`${formatLongDateFromLocal(c)}, ${day.slots.length} times`}
                      aria-current={isSel ? "date" : undefined}
                      className="group relative mx-auto flex h-10 w-10 items-center justify-center rounded-full font-semibold"
                      style={{ color: isSel ? "#fff" : accent }}
                    >
                      <Wheel accent={accent} selected={isSel} />
                      <span className="relative">{n}</span>
                    </a>
                  );
                })}
              </div>
            </>
          )}
          <div className="mt-6 text-xs text-muted">{typeof zone === "string" ? <p>Times are shown in {zone}.</p> : zone}</div>
        </div>

        {selected && (
          <div className="border-t border-border p-6 @3xl:col-start-2 @4xl:col-start-3 @4xl:row-start-1 @4xl:border-l @4xl:border-t-0">
            <p className="mb-3 font-medium">{formatLongDateFromLocal(selected.date)}</p>
            <ul className="max-h-[420px] space-y-2 overflow-y-auto pr-1" aria-label="Available times">
              {selected.slots.map((s) => (
                <li key={s.time}>
                  {s.time === time ? (
                    <div className="flex">
                      <span className="flex h-11 min-w-0 flex-1 items-center justify-center whitespace-nowrap rounded-lg text-sm font-semibold text-white" style={{ background: "#475569" }}>{s.label}</span>
                      <div className="slot-next">
                        <Link href={href({ month: shown, date: selected.date, time: s.time, confirm: "1" })} className="flex h-11 w-full items-center justify-center whitespace-nowrap rounded-lg text-sm font-semibold text-white" style={{ background: accent }}>Next</Link>
                      </div>
                    </div>
                  ) : (
                    <a href={href({ month: shown, date: selected.date, time: s.time })} onClick={go({ month: shown, date: selected.date, time: s.time })} className="flex h-11 items-center justify-center rounded-lg border text-sm font-semibold hover:border-2" style={{ borderColor: accent, color: accent }}>
                      {s.label}
                    </a>
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
export function Wheel({ accent, selected }: { accent: string; selected: boolean }) {
  // A bike wheel side-on: thin black tyre, a fine rim, spokes running in to the hub, and the hub (in the type's
  // colour) where the date sits. The picked day gets a solid hub; the others a light one. Spokes turn on hover.
  const hub = selected ? accent : `color-mix(in srgb, ${accent} 14%, white)`;
  const spoke = `color-mix(in srgb, ${accent} 45%, white)`;
  return (
    <svg aria-hidden="true" viewBox="0 0 40 40" className="absolute inset-0 h-full w-full">
      <circle cx="20" cy="20" r="18.4" fill="none" stroke="#17181a" strokeWidth="2.6" />
      <circle cx="20" cy="20" r="16.4" fill="none" stroke="#a8a29e" strokeWidth="0.8" />
      <g stroke={spoke} strokeWidth="0.6" className="origin-center transition-transform duration-500 motion-safe:group-hover:rotate-45" style={{ transformBox: "fill-box" }}>
        {WHEEL_SPOKES.map(([x1, y1, x2, y2]) => <line key={`${x1},${y1}`} x1={x1} y1={y1} x2={x2} y2={y2} />)}
      </g>
      <circle cx="20" cy="20" r="11.5" fill={hub} stroke={selected ? "none" : spoke} strokeWidth="0.6" />
    </svg>
  );
}

/** 12 spokes laced like a real wheel: each leaves the hub and meets the rim further round, alternate ones leaning opposite ways. */
// Rounded, so the server's and the browser's numbers match exactly (no hydration mismatch). [x1, y1, x2, y2]
const WHEEL_SPOKES = Array.from({ length: 12 }, (_, i) => {
  const h = (i * 30 * Math.PI) / 180, r = ((i * 30 + (i % 2 ? 10 : -10)) * Math.PI) / 180;
  const at = (radius: number, a: number, f: (n: number) => number) => (20 + radius * f(a)).toFixed(3);
  return [at(11.5, h, Math.cos), at(11.5, h, Math.sin), at(16, r, Math.cos), at(16, r, Math.sin)];
});
