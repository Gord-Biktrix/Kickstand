"use client";

import { useEffect, useRef, useState } from "react";
import { Wheel } from "./booking-calendar-picker";
import { zoneAt } from "@/lib/tz-rules";

const ACCENT = "#c2410c";

const pad = (n: number) => String(n).padStart(2, "0");
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Calendar maths on plain "YYYY-MM-DD" strings (no time zones involved). */
function parts(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return { y, m, day };
}
function weekday(d: string) {
  const { y, m, day } = parts(d);
  return new Date(Date.UTC(y, m - 1, day)).getUTCDay();
}
function label12(t: string) {
  const [h, mi] = t.split(":").map(Number);
  return `${h % 12 || 12}:${pad(mi)} ${h < 12 ? "am" : "pm"}`;
}
/** "Mon 16 Nov, 4:00 pm" from "2026-11-16T16:00". */
export function readyLabel(v: string) {
  const [d, t] = v.split("T");
  if (!d || !t) return "Pick a time";
  const { m, day } = parts(d);
  return `${DAY[weekday(d)]} ${day} ${MONTH[m - 1]}, ${label12(t)}`;
}
/** Today's date and time in the store's zone, read when the picker opens. */
function nowIn(tz: string) {
  const at = new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zoneAt(tz, at), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const TIMES = Array.from({ length: (21 - 7) * 4 + 1 }, (_, i) => `${pad(7 + Math.floor(i / 4))}:${pad((i % 4) * 15)}`);

/**
 * Ready-by, Kickstand style: a button with the day and time; tapping opens a small month (circles like the booking
 * calendar) and the day's times in 15-minute steps. Past days and times are greyed out. Posts as `name`.
 */
export function ReadyPicker({ name, value, tz, onChange }: { name: string; value: string; tz: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [today, setToday] = useState<{ date: string; time: string } | null>(null);
  const [month, setMonth] = useState(() => value.slice(0, 7));
  const box = useRef<HTMLDivElement>(null);
  const picked = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [date, time] = value.split("T");

  useEffect(() => {
    if (!open) return;
    // Scroll only the time list (not the page) to the chosen time.
    if (list.current && picked.current) list.current.scrollTop = picked.current.offsetTop - list.current.clientHeight / 2;
    const out = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", out);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", out); document.removeEventListener("keydown", esc); };
  }, [open]);

  const { y, m } = parts(`${month}-01`);
  const first = weekday(`${month}-01`);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const shift = (n: number) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`);
  };
  const isPast = (d: string) => !!today && d < today.date;

  return (
    <div ref={box} className="relative">
      <input type="hidden" name={name} value={value} />
      <button
        type="button"
        onClick={() => { setToday(nowIn(tz)); setMonth(value.slice(0, 7)); setOpen((o) => !o); }}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-bold"
      >
        <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[#c2410c]"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
        {readyLabel(value)}
        <span aria-hidden className="text-[#c2410c]">▾</span>
      </button>

      {open && (
        <div role="dialog" aria-label="Ready by" className="absolute top-full left-0 z-30 mt-2 flex w-[min(92vw,520px)] gap-4 rounded-2xl border border-border bg-card p-4 shadow-xl">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex items-center justify-between">
              <button type="button" onClick={() => shift(-1)} aria-label="Previous month" className="h-9 w-9 rounded-full text-lg hover:bg-[#f7f6f3]">‹</button>
              <p className="text-sm font-bold">{MONTH_LONG[m - 1]} {y}</p>
              <button type="button" onClick={() => shift(1)} aria-label="Next month" className="h-9 w-9 rounded-full text-lg hover:bg-[#f7f6f3]">›</button>
            </div>
            <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-bold tracking-wider text-muted uppercase">
              {DAY.map((d) => <span key={d}>{d.slice(0, 1)}</span>)}
            </div>
            <div className="mt-1 grid grid-cols-7 gap-1">
              {Array.from({ length: first }, (_, i) => <span key={`b${i}`} />)}
              {Array.from({ length: days }, (_, i) => {
                const d = `${month}-${pad(i + 1)}`;
                const on = d === date;
                const past = isPast(d);
                return (
                  <button
                    key={d}
                    type="button"
                    disabled={past}
                    onClick={() => onChange(`${d}T${time}`)}
                    aria-pressed={on}
                    aria-label={`${DAY[weekday(d)]} ${i + 1}`}
                    className={`group relative mx-auto flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold ${past ? "text-[#cfcbc4]" : ""}`}
                    style={past ? undefined : { color: on ? "#fff" : ACCENT }}
                  >
                    {!past && <Wheel accent={ACCENT} selected={on} />}
                    <span className="relative">{i + 1}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="w-28 shrink-0">
            <p className="mb-2 text-sm font-bold">{date ? `${DAY[weekday(date)]} ${parts(date).day}` : "Time"}</p>
            <ul ref={list} className="relative max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {TIMES.map((t) => {
                const past = !!today && date === today.date && t < today.time;
                const on = t === time;
                return (
                  <li key={t}>
                    <button
                      ref={on ? picked : undefined}
                      type="button"
                      disabled={past}
                      onClick={() => { onChange(`${date}T${t}`); setOpen(false); }}
                      aria-pressed={on}
                      className={`w-full rounded-lg border py-2 text-sm font-semibold ${on ? "border-[#c2410c] bg-[#c2410c] text-white" : past ? "border-border text-[#cfcbc4]" : "border-[#c2410c] text-[#9a3412] hover:bg-[#fff1e8]"}`}
                    >
                      {label12(t)}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
