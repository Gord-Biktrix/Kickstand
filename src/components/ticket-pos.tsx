"use client";

import { useRef, useState } from "react";
import type { Picked } from "./customer-picker";
import { TicketCustomerBike } from "./ticket-customer-bike";

type Service = { key: string; name: string; minutes: number };
type Line = { id: string; kind: "service" | "labour"; name: string; minutes: number };

const label = "text-[11px] font-extrabold tracking-wider text-[#3d3f43] uppercase";
const LABOUR = [15, 30, 45, 60, 90];
const mins = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`);

/** Ready-by default: now + the work, rounded up to the next quarter hour. */
function readyAfter(minutes: number, tz: string): string {
  return localValue(new Date(Math.ceil((Date.now() + minutes * 60_000) / 900_000) * 900_000), tz);
}

/** "2026-11-16T17:30" in the store's time zone, for a datetime-local input. */
function localValue(d: Date, tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/**
 * New ticket as a POS: the ticket on the left like a cart (customer, their bike, the lines added, what they say,
 * ready-by, one big button), and what you can add on the right (service tiles, labour, search), like Shopify POS.
 * Tapping a tile adds a line; × removes it. "Schedule for later" opens the booking calendar instead of checking in now.
 * Posts: c / nn / np / ne, bike, serial, sid, service[] and labour[] (one per line), said, ready, mech.
 */
export function TicketPos(props: {
  services: Service[];
  employees: { id: string; name: string }[];
  tz: string;
  enabled: boolean;
  canSchedule: boolean;
  defaultMinutes: number;
  initial: { pick: Picked | null; newCustomer: { nn: string; np: string; ne: string }; bike: string; serial: string; sid: string; services: string[]; labour: string[]; said: string; ready: string; mech: string };
}) {
  const { services, tz } = props;
  const [lines, setLines] = useState<Line[]>(() => [
    ...props.initial.services.map((name, i) => ({ id: `s${i}`, kind: "service" as const, name, minutes: services.find((s) => s.name === name)?.minutes ?? props.defaultMinutes })),
    ...props.initial.labour.map((m, i) => ({ id: `l${i}`, kind: "labour" as const, name: "Labour", minutes: Number(m) || 15 })),
  ]);
  const [ready, setReady] = useState(props.initial.ready);
  const [readyTouched, setReadyTouched] = useState(false);
  const [tab, setTab] = useState<"services" | "labour">("services");
  const [search, setSearch] = useState("");
  const total = lines.reduce((s, l) => s + l.minutes, 0);
  const nextId = useRef(0);

  function update(next: Line[]) {
    setLines(next);
    if (!readyTouched) {
      setReady(readyAfter(next.reduce((s, l) => s + l.minutes, 0) || props.defaultMinutes, tz));
    }
  }
  const addService = (s: Service) => update([...lines, { id: `n${++nextId.current}`, kind: "service", name: s.name, minutes: s.minutes }]);
  const addLabour = (m: number) => update([...lines, { id: `n${++nextId.current}`, kind: "labour", name: "Labour", minutes: m }]);
  const remove = (id: string) => update(lines.filter((l) => l.id !== id));
  const shown = services.filter((s) => !search.trim() || s.name.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <>
      {/* The ticket, like a POS cart. */}
      <section aria-label="New ticket" className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-col gap-4 border-b border-border p-4">
          <TicketCustomerBike initial={props.initial.pick} initialNew={props.initial.newCustomer} bike={props.initial.bike} serial={props.initial.serial} sid={props.initial.sid} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-[#f7f6f3] px-4 py-2.5 text-sm">
          <span><strong>New walk-in</strong> · drop-off now</span>
          <label className="flex items-center gap-2">
            <span>Ready by</span>
            <input name="ready" type="datetime-local" value={ready} onChange={(e) => { setReady(e.target.value); setReadyTouched(true); }} className="rounded-md border border-border bg-card px-2 py-1 text-sm font-semibold" />
          </label>
        </div>

        <div className="flex-1 px-4">
          {lines.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">Tap what it needs on the right.</p>
          ) : (
            <ul className="divide-y divide-border">
              {lines.map((l) => (
                <li key={l.id} className="flex items-center gap-3 py-3">
                  <input type="hidden" name={l.kind === "service" ? "service" : "labour"} value={l.kind === "service" ? l.name : String(l.minutes)} />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{l.kind === "labour" ? `Labour · ${mins(l.minutes)}` : l.name}</p>
                    <p className="text-sm text-muted">{l.kind === "labour" ? "Extra time" : `about ${mins(l.minutes)}`}</p>
                  </div>
                  <button type="button" onClick={() => remove(l.id)} aria-label={`Remove ${l.name}`} className="h-9 w-9 rounded-md border border-border text-lg text-muted">×</button>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-border py-3">
            <label htmlFor="said" className={label}>What they say</label>
            <textarea id="said" name="said" defaultValue={props.initial.said} rows={2} placeholder="In their words" className="input mt-1 min-h-16 py-2 text-base" />
          </div>
        </div>

        <div className="border-t border-border p-4">
          <div className="mb-3 flex items-end justify-between gap-3">
            <label className="grid gap-1 text-sm">
              <span className={label}>Mechanic</span>
              <select name="mech" defaultValue={props.initial.mech} className="input h-10 w-auto text-base">
                <option value="">Not assigned</option>
                {props.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </label>
            <div className="text-right">
              <p className="text-sm text-muted">Work</p>
              <p className="text-xl font-extrabold">{total ? mins(total) : "—"}</p>
            </div>
          </div>
          <button type="submit" disabled={!props.enabled} className="flex min-h-16 w-full items-center justify-center rounded-xl bg-[#ff6b1a] text-lg font-extrabold text-[#17181a] disabled:opacity-50">Check in · create ticket</button>
          {props.canSchedule && (
            <button type="submit" formAction="/app/workshop/new" formMethod="get" name="schedule" value="1" className="btn mt-2 min-h-12 w-full">Schedule for later</button>
          )}
          <p className="mt-2 text-xs text-muted">Check in creates the Lightspeed work order now (Open) and puts it in To do. Schedule books a service appointment instead.</p>
        </div>
      </section>

      {/* What you can add, like POS tiles. */}
      <section aria-label="Add to the ticket" className="flex min-w-0 flex-col gap-3">
        <input value={search} onChange={(e) => { setSearch(e.target.value); setTab("services"); }} placeholder="Search services…" aria-label="Search services" className="input h-12 text-base" />
        <div role="tablist" aria-label="What to add" className="flex flex-wrap gap-2">
          {(["services", "labour"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`min-h-10 rounded-full border px-4 text-sm font-semibold ${tab === t ? "border-[#17181a] bg-[#17181a] text-white" : "border-border bg-card"}`}>
              {t === "services" ? "Services" : "Labour"}
            </button>
          ))}
          <button type="button" role="tab" aria-selected={false} disabled title="Comes after the Lightspeed test" className="min-h-10 rounded-full border border-border bg-card px-4 text-sm font-semibold text-muted opacity-60">Parts</button>
          <button type="button" role="tab" aria-selected={false} disabled title="Comes after the Lightspeed test" className="min-h-10 rounded-full border border-border bg-card px-4 text-sm font-semibold text-muted opacity-60">Usual for this bike</button>
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
          {tab === "services"
            ? shown.map((s) => {
                const added = lines.filter((l) => l.kind === "service" && l.name === s.name).length;
                return (
                  <button key={s.key} type="button" onClick={() => addService(s)} className={`flex min-h-24 flex-col justify-between rounded-xl border bg-card p-3 text-left ${added ? "border-2 border-[#17181a]" : "border-border"}`}>
                    <span className="font-bold">{s.name}</span>
                    <span className="text-sm text-muted">about {mins(s.minutes)}{added ? ` · added${added > 1 ? ` ×${added}` : ""}` : ""}</span>
                  </button>
                );
              })
            : LABOUR.map((m) => (
                <button key={m} type="button" onClick={() => addLabour(m)} className="flex min-h-24 flex-col justify-between rounded-xl border border-border bg-[#f7f6f3] p-3 text-left">
                  <span className="font-bold">+ {mins(m)}</span>
                  <span className="text-sm text-muted">Labour</span>
                </button>
              ))}
        </div>
        <p className="text-sm text-muted">Tap to add to the ticket. The services and labour go on the Lightspeed work order&apos;s note; priced parts and labour lines (and the Parts and Usual tabs) come after a test on a real work order.</p>
      </section>
    </>
  );
}
