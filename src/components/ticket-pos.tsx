"use client";

import { useEffect, useRef, useState } from "react";
import type { Picked } from "./customer-picker";
import { readyLabel } from "./ready-picker";
import { Wheel } from "./booking-calendar-picker";
import { TicketCustomerBike } from "./ticket-customer-bike";
import { estimateReady, type WeeklyHours } from "@/lib/ready-estimate";
import { zoneAt } from "@/lib/tz-rules";

/** A service or labour tile: a Lightspeed item (itemId, price) or one of Kickstand's starter services. */
type Service = { key: string; name: string; minutes: number; itemId?: string; price?: number | null };
type Part = { itemId: string; name: string; price: number | null };
/** A line on the ticket. Tapping the same tile again adds to its quantity. */
type Line = { key: string; kind: "service" | "labour" | "part"; name: string; minutes: number; qty: number; itemId?: string; price?: number | null };

const label = "text-[11px] font-extrabold tracking-wider text-[#3d3f43] uppercase";
const LABOUR = [15, 30, 45, 60, 90];
const ACCENT = "#c2410c";
const mins = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`);
const money = (n: number) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n);

/** "2026-11-16T17:30" in the store's time zone. */
function localValue(d: Date, tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zoneAt(tz, d), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
/** Ready-by default: after the benches' queue plus this work, in open hours (lib/ready-estimate.ts). */
function readyAfter(work: number, loads: number[], hours: WeeklyHours, tz: string, dropoff: string): string {
  // Walk-in: after the benches' queue. A later drop-off: from that time (the queue then isn't known yet).
  const later = dropoff !== "now";
  return localValue(estimateReady({ now: later ? new Date(dropoff) : new Date(), work, loads: later ? [0] : loads, hours, tz }), tz);
}


/** "next bench free now" / "next bench free in 1 h 30 min (3 h queued)". */
function queueText(loads: number[]): string {
  const free = Math.min(...loads);
  const total = loads.reduce((a, b) => a + b, 0);
  if (!total) return "all benches free";
  return `${free ? `next bench free in ${mins(free)}` : "a bench is free now"} · ${mins(total)} queued`;
}

/**
 * New ticket as a POS: the ticket on the left like a cart (customer, their bike, the lines with − qty +, what they
 * say, ready-by, one big button), and what you can add on the right: service tiles, labour, and parts from Lightspeed
 * for the chosen bike. Posts c / nn / np / ne, bike, serial, sid, service[] and labour[] (repeated per quantity),
 * part[] ("itemId|qty|name"), said, ready, mech.
 */
export function TicketPos(props: {
  services: Service[];
  /** Lightspeed labour items ("15min", "1h30"); empty → the fixed labour buttons. */
  labourItems: Service[];
  /** Why the tiles aren't from Lightspeed, when they aren't. */
  tilesNote: string;
  employees: { id: string; name: string }[];
  tz: string;
  enabled: boolean;
  /** Open service-appointment slots by day (empty when the store has no service type). The first is "Earliest available". */
  days: ServiceDay[];
  /** "now", or a slot's ISO time (comes back after an error). */
  initialDropoff: string;
  /** Today in the store, e.g. "Mon 16 Nov": what the date field shows until a day is picked. */
  todayLabel: string;
  defaultMinutes: number;
  benches: number;
  loads: number[];
  hours: WeeklyHours;
  initial: { pick: Picked | null; newCustomer: { nn: string; np: string; ne: string }; bike: string; serial: string; sid: string; services: string[]; labour: string[]; parts: string[]; said: string; ready: string; mech: string };
}) {
  const { services, tz } = props;
  const [lines, setLines] = useState<Line[]>(() => {
    const out: Line[] = [];
    const bump = (l: Omit<Line, "qty">) => {
      const found = out.find((x) => x.key === l.key);
      if (found) found.qty++;
      else out.push({ ...l, qty: 1 });
    };
    for (const name of props.initial.services) {
      const t = [...services, ...props.labourItems].find((s) => s.name === name);
      bump({ key: `s:${name}`, kind: "service", name, minutes: t?.minutes ?? props.defaultMinutes, itemId: t?.itemId, price: t?.price ?? null });
    }
    for (const m of props.initial.labour) bump({ key: `l:${m}`, kind: "labour", name: `Labour ${mins(Number(m) || 15)}`, minutes: Number(m) || 15 });
    for (const p of props.initial.parts) {
      const [itemId, qty, ...name] = p.split("|");
      // Service items come back as parts too; they're already a service line.
      if (itemId && !out.some((l) => l.itemId === itemId)) out.push({ key: `p:${itemId}`, kind: "part", name: name.join("|"), minutes: 0, qty: Number(qty) || 1, itemId, price: null });
    }
    return out;
  });
  const [ready, setReady] = useState(props.initial.ready);
  const [tab, setTab] = useState<"all" | "services" | "labour" | "parts">("all");
  const [search, setSearch] = useState("");
  const [bike, setBike] = useState(props.initial.bike);
  const [parts, setParts] = useState<Part[]>([]);
  const [partsState, setPartsState] = useState<"idle" | "loading" | "error">("idle");
  const [partsError, setPartsError] = useState("");
  const seq = useRef(0);
  const [dropoff, setDropoff] = useState<string>(props.initialDropoff);
  const earliest = props.days[0]?.slots[0] ?? null;
  const dropLabel = props.days.flatMap((d) => d.slots).find((sl) => sl.iso === dropoff)?.label ?? "";
  // The picked day and time, for the date button: same two-line shape as Now and Earliest, so the row doesn't reflow.
  const pickedDayRow = props.days.find((d) => d.slots.some((sl) => sl.iso === dropoff));
  const pickedTime = pickedDayRow?.slots.find((sl) => sl.iso === dropoff)?.time ?? "";
  // The date field opens the calendar in a modal; picking a time (or Esc, or a click outside) closes it.
  const [calOpen, setCalOpen] = useState(false);
  // Phones: the tiles live in a sheet over the ticket, opened from "Add service, labour or part" (always shown on lg).
  const [addOpen, setAddOpen] = useState(false);
  // Laptops, like a POS: the ticket and the tiles fill the room left on screen and each scrolls on its own, so the
  // page itself stays put and the button is always in view. Sized from where the form starts, on load and resize.
  const ticket = useRef<HTMLElement>(null);
  useEffect(() => {
    const form = ticket.current?.parentElement;
    if (!form) return;
    const wide = window.matchMedia("(min-width: 1024px)");
    const fit = () => {
      if (!wide.matches) { form.style.height = ""; form.style.gridTemplateRows = ""; return; }
      const top = form.getBoundingClientRect().top + window.scrollY;
      form.style.height = `${Math.max(480, window.innerHeight - top - 24)}px`;
      form.style.gridTemplateRows = "minmax(0, 1fr)";
    };
    fit();
    window.addEventListener("resize", fit);
    wide.addEventListener("change", fit);
    return () => { window.removeEventListener("resize", fit); wide.removeEventListener("change", fit); form.style.height = ""; form.style.gridTemplateRows = ""; };
  }, []);
  useEffect(() => {
    if (!addOpen) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setAddOpen(false);
    document.addEventListener("keydown", esc);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", esc); document.body.style.overflow = overflow; };
  }, [addOpen]);
  const pickedDay = dropoff !== "now" && dropoff !== earliest?.iso;

  const work = lines.reduce((s, l) => s + l.minutes * l.qty, 0);
  const partsTotal = lines.filter((l) => l.price != null).reduce((s, l) => s + (l.price ?? 0) * l.qty, 0);

  // Parts tab: Lightspeed items for the chosen bike, or what's typed. All: parts matching what's typed (2+ letters).
  useEffect(() => {
    const q = search.trim();
    if (tab === "all" ? q.length < 2 : tab !== "parts" || (!q && !bike)) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      setPartsState("loading");
      try {
        const res = await fetch(`/api/parts?${new URLSearchParams({ q, bike: tab === "all" ? "" : bike }).toString()}`, { cache: "no-store" });
        const json = (await res.json()) as { parts?: Part[]; error?: string };
        if (mine !== seq.current) return;
        setParts(json.parts ?? []);
        setPartsError(json.error ?? "");
        setPartsState(json.error ? "error" : "idle");
      } catch {
        if (mine === seq.current) { setParts([]); setPartsState("error"); setPartsError("Lightspeed didn't answer."); }
      }
    }, 300);
    return () => clearTimeout(t);
  }, [tab, search, bike]);

  function update(next: Line[]) {
    setLines(next);
    const w = next.reduce((s, l) => s + l.minutes * l.qty, 0);
    setReady(next.length ? readyAfter(w || props.defaultMinutes, props.loads, props.hours, tz, dropoff) : "");
  }
  function chooseDropoff(d: string) {
    setDropoff(d);
    if (lines.length) setReady(readyAfter(work || props.defaultMinutes, props.loads, props.hours, tz, d));
  }
  function add(l: Omit<Line, "qty">) {
    const found = lines.find((x) => x.key === l.key);
    update(found ? lines.map((x) => (x.key === l.key ? { ...x, qty: Math.min(99, x.qty + 1) } : x)) : [...lines, { ...l, qty: 1 }]);
  }
  function step(key: string, by: number) {
    update(lines.flatMap((x) => (x.key !== key ? [x] : x.qty + by <= 0 ? [] : [{ ...x, qty: Math.min(99, x.qty + by) }])));
  }
  const qtyOf = (key: string) => lines.find((l) => l.key === key)?.qty ?? 0;
  const query = search.trim().toLowerCase();
  const match = (name: string) => !query || name.toLowerCase().includes(query);
  const shown = services.filter((s) => match(s.name));
  const labourShown = props.labourItems.filter((s) => match(s.name));
  const presetsShown = props.labourItems.length ? [] : LABOUR.filter((m) => match(`${mins(m)} labour`));
  // All: services and labour as they match; Lightspeed parts once 2+ letters are typed.
  const partsInAll = tab === "all" && query.length >= 2;
  const model = bike.replace(/^\d+\s*-\s*/, "").split(/[·,]/)[0].trim().split(/\s+/).slice(0, 2).join(" ");

  const serviceTile = (s: (typeof services)[number], muted: boolean) => (
    <Tile key={s.key} muted={muted} name={s.name} sub={[s.price != null ? money(s.price) : null, muted ? "Labour" : `about ${mins(s.minutes)}`].filter(Boolean).join(" · ")} qty={qtyOf(`s:${s.name}`)} onAdd={() => add({ key: `s:${s.name}`, kind: "service", name: s.name, minutes: s.minutes, itemId: s.itemId, price: s.price ?? null })} onStep={(by) => step(`s:${s.name}`, by)} />
  );
  const partTile = (p: Part) => (
    <Tile key={p.itemId} name={p.name} sub={p.price != null ? money(p.price) : "Price in Lightspeed"} qty={qtyOf(`p:${p.itemId}`)} onAdd={() => add({ key: `p:${p.itemId}`, kind: "part", name: p.name, minutes: 0, itemId: p.itemId, price: p.price })} onStep={(by) => step(`p:${p.itemId}`, by)} />
  );

  return (
    <>
      {/* The ticket, like a POS cart. */}
      {/* Laptops: the ticket stays in view at window height and scrolls on its own; the button stays at its foot. */}
      <section ref={ticket} aria-label="New ticket" className="flex flex-col rounded-xl border border-border bg-card lg:h-full lg:min-h-0">
        <div className="relative flex flex-1 flex-col lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain">
        <div className="flex flex-col gap-4 border-b border-border p-4">
          <TicketCustomerBike initial={props.initial.pick} initialNew={props.initial.newCustomer} bike={props.initial.bike} serial={props.initial.serial} sid={props.initial.sid} onBike={setBike} />
        </div>

        <div className="flex flex-col gap-3 border-b border-border bg-[#f7f6f3] px-4 py-3 text-sm">
          <input type="hidden" name="dropoff" value={dropoff} />
          <div>
            <p className={label}>Schedule service</p>
            <div className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] gap-2" role="radiogroup" aria-label="Schedule service">
              <DropButton on={dropoff === "now"} onClick={() => chooseDropoff("now")} title="Now" sub="walk-in" />
              {earliest && <DropButton on={dropoff === earliest.iso} onClick={() => chooseDropoff(earliest.iso)} title={<><span className="lg:hidden">Earliest</span><span className="hidden lg:inline">Earliest available</span></>} sub={earliest.label} />}
              {earliest && (
                <button type="button" role="radio" aria-checked={pickedDay} onClick={() => setCalOpen(true)} className={`min-h-12 min-w-0 rounded-lg border px-2.5 py-1.5 text-left lg:px-3 ${pickedDay ? "border-[#015d47] bg-[#015d47] text-white" : "border-border bg-card"}`}>
                  <span className="flex items-center gap-1.5 text-sm font-bold"><CalendarIcon /><span className="truncate">{pickedDay && pickedDayRow ? pickedDayRow.label : props.todayLabel}</span></span>
                  <span className={`block truncate text-xs ${pickedDay ? "text-white/75" : "text-muted"}`}>{pickedDay ? pickedTime : "Pick a day"}</span>
                </button>
              )}
            </div>
            {calOpen && props.days.length > 0 && <CalendarModal onClose={() => setCalOpen(false)}><DayCalendar days={props.days} value={dropoff} onPick={(iso) => { chooseDropoff(iso); setCalOpen(false); }} /></CalendarModal>}
          </div>
          <div className="hidden lg:block">
            <p className={label}>Ready by</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {lines.length > 0 && ready ? (
                <>
                  <input type="hidden" name="ready" value={ready} />
                  <span className="text-base font-bold">{readyLabel(ready)}</span>
                </>
              ) : (
                <span className="text-muted">Add the work first</span>
              )}
            </div>
            <p className="mt-1 text-xs text-muted">
              {dropoff === "now" ? `${props.benches} bench${props.benches === 1 ? "" : "es"} · ${queueText(props.loads)}` : "From drop-off, in open hours"}
            </p>
          </div>
        </div>

        <div className="flex-1 px-4">
          {lines.length === 0 ? (
            <p className="hidden py-6 text-center text-sm text-muted lg:block">Tap what it needs on the right.</p>
          ) : (
            <ul className="divide-y divide-border">
              {lines.map((l) => (
                <li key={l.key} className="flex items-center gap-3 py-3">
                  {l.kind !== "part" && Array.from({ length: l.qty }, (_, i) => (
                    <input key={i} type="hidden" name={l.kind} value={l.kind === "service" ? l.name : String(l.minutes)} />
                  ))}
                  {/* A Lightspeed item (part or service) goes on the work order as a line. */}
                  {l.itemId && <input type="hidden" name="part" value={`${l.itemId}|${l.qty}|${l.name}`} />}
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{l.name}</p>
                    <p className="text-sm text-muted">
                      {l.kind === "part" ? (l.price != null ? `${money(l.price)} each` : "Part") : l.kind === "labour" ? "Extra time" : [`about ${mins(l.minutes)}`, l.price != null ? money(l.price) : null].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <div className="flex items-center rounded-full border border-border" role="group" aria-label={`${l.name} quantity`}>
                    <button type="button" onClick={() => step(l.key, -1)} aria-label={`One less ${l.name}`} className="h-9 w-9 rounded-full text-lg font-bold hover:bg-[#f7f6f3]">−</button>
                    <span className="w-6 text-center font-bold tabular-nums" aria-live="polite">{l.qty}</span>
                    <button type="button" onClick={() => step(l.key, 1)} aria-label={`One more ${l.name}`} className="h-9 w-9 rounded-full text-lg font-bold hover:bg-[#f7f6f3]">+</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => setAddOpen(true)} className="my-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[#cfcbc4] text-sm font-bold lg:hidden">
            <span aria-hidden className="text-lg leading-none">+</span> Add service, labour or part
          </button>
          <div className="border-t border-border py-3">
            <label htmlFor="said" className={label}>Notes</label>
            <textarea id="said" name="said" defaultValue={props.initial.said} rows={2} placeholder="What they said, what you noticed" className="input mt-1 min-h-16 py-2 text-base" />
            <PhotoAdd />
            <label className="mt-3 flex items-center justify-between gap-3 text-sm">
              <span className={label}>Mechanic</span>
              <select name="mech" defaultValue={props.initial.mech} className="input h-10 w-auto text-base">
                <option value="">Not assigned</option>
                {props.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </label>
          </div>
        </div>
        </div>

        {/* Phones: the total, Ready by and the button stay at the bottom of the screen. */}
        <div className="sticky bottom-0 z-30 rounded-b-xl border-t border-border bg-card p-4 max-lg:px-3 max-lg:py-2.5 max-lg:shadow-[0_-4px_12px_rgba(0,0,0,0.06)] lg:static">
          <div className="mb-3 flex items-end justify-between gap-3 max-lg:mb-2 max-lg:items-baseline">
            <p className="text-sm text-muted lg:hidden">{work ? `${mins(work)} of work` : "No work yet"}{partsTotal ? ` · ${money(partsTotal)}` : ""}</p>
            <p className="text-sm font-bold lg:hidden">{lines.length > 0 && ready ? `Ready ${readyLabel(ready)}` : ""}</p>
            <div className="hidden text-right lg:ml-auto lg:block">
              <p className="text-sm text-muted">Work{partsTotal ? " · before tax" : ""}</p>
              <p className="text-xl font-extrabold">{work ? mins(work) : "—"}{partsTotal ? ` · ${money(partsTotal)}` : ""}</p>
            </div>
          </div>
          {dropoff !== "now" && (
            <label className="mb-2 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="sms_consent" className="h-5 w-5" /> Customer agrees to texts about this booking</label>
          )}
          <button type="submit" disabled={!props.enabled} className="flex min-h-14 w-full items-center justify-center rounded-xl lg:min-h-16 bg-[#ff6b1a] px-4 text-center text-lg font-extrabold text-[#17181a] disabled:opacity-50">
            {dropoff === "now" ? "Check in · create ticket" : `Book service · ${dropLabel}`}
          </button>
          <p className="mt-2 hidden text-xs text-muted lg:block">{dropoff === "now" ? "Creates the Lightspeed work order now (Open, with the lines) and puts it in To do." : "Books the service appointment (the customer gets a confirmation) and puts the lines on its Lightspeed work order."}</p>
        </div>
      </section>

      {/* What you can add, like POS tiles. */}
      {addOpen && <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setAddOpen(false)} aria-hidden />}
      <section aria-label="Add to the ticket" className={`min-w-0 flex-col gap-3 lg:static lg:z-auto lg:flex lg:h-full lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:rounded-none lg:bg-transparent lg:px-2 lg:pt-0 lg:pb-4 lg:shadow-none ${addOpen ? "fixed inset-x-0 top-12 bottom-0 z-50 flex overflow-y-auto rounded-t-2xl bg-card p-4 shadow-2xl" : "hidden"}`}>
        <div className="flex items-center justify-between lg:hidden">
          <span aria-hidden className="mx-auto h-1 w-10 rounded-full bg-[#cfcbc4]" />
        </div>
        {/* Laptops: search and tabs stay at the top while the tiles scroll. */}
        <div className="flex flex-col gap-3 lg:sticky lg:top-0 lg:z-10 lg:bg-background lg:pt-1 lg:pb-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tab === "parts" && model ? `Search items (showing parts for ${model})…` : "Search items…"} aria-label="Search" className="input h-12 text-base" />
        <div role="tablist" aria-label="What to add" className="flex flex-wrap gap-2">
          {([["all", "All"], ["services", "Services"], ["labour", "Labour"], ["parts", model ? `Parts for ${model}` : "Parts"]] as const).map(([t, text]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`min-h-10 rounded-full border px-4 text-sm font-semibold ${tab === t ? "border-[#015d47] bg-[#015d47] text-white" : "border-border bg-card"}`}>
              {text}
            </button>
          ))}
        </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
          {(tab === "all" || tab === "services") && shown.map((s) => serviceTile(s, false))}
          {(tab === "all" || tab === "labour") && labourShown.map((s) => serviceTile(s, true))}
          {(tab === "all" || tab === "labour") &&
            presetsShown.map((m) => (
              <Tile key={m} muted name={`+ ${mins(m)}`} sub="Labour" qty={qtyOf(`l:${m}`)} onAdd={() => add({ key: `l:${m}`, kind: "labour", name: `Labour ${mins(m)}`, minutes: m })} onStep={(by) => step(`l:${m}`, by)} />
            ))}
          {tab === "parts" && parts.map(partTile)}
        </div>
        {partsInAll && (
          <>
            <p className={`${label} mt-1`}>Parts in Lightspeed</p>
            {parts.length > 0 && partsState !== "loading" && <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">{parts.map(partTile)}</div>}
            <p className="text-sm text-muted">
              {partsState === "loading" ? "Looking in Lightspeed…" : partsState === "error" ? `Lightspeed didn't send parts (${partsError}).` : parts.length === 0 ? `No parts match “${search.trim()}”.` : "Tap to add; parts go on the work order as lines."}
            </p>
          </>
        )}
        {tab === "all" && !query && <p className="text-sm text-muted">Type to search parts too.</p>}
        {(tab === "services" || tab === "labour") && !shown.length && !labourShown.length && !presetsShown.length && query && <p className="text-sm text-muted">Nothing matches “{search.trim()}”.</p>}
        {tab === "parts" && (
          <p className="text-sm text-muted">
            {partsState === "loading"
              ? "Looking in Lightspeed…"
              : partsState === "error"
                ? `Lightspeed didn't send parts (${partsError}).`
                : !bike && !search.trim()
                  ? "Pick the customer's bike, or search, to see parts."
                  : parts.length === 0
                    ? `No parts in Lightspeed match “${search.trim() || model}”. Try another word.`
                    : `Lightspeed items matching “${search.trim() || model}”. Tap to add; they go on the work order as lines.`}
          </p>
        )}
        {tab !== "parts" && !partsInAll && (
          <p className="text-sm text-muted">
            {props.tilesNote || "Your Lightspeed service and labour items. Tap to add (again for more); each goes on the work order as a line at its Lightspeed price."}
          </p>
        )}
        <button type="button" onClick={() => setAddOpen(false)} className="sticky bottom-0 mt-auto min-h-12 w-full rounded-xl bg-[#17181a] text-base font-bold text-white lg:hidden">
          Done{lines.length ? ` · ${lines.reduce((n, l) => n + l.qty, 0)} item${lines.reduce((n, l) => n + l.qty, 0) === 1 ? "" : "s"}${work ? ` · ${mins(work)}` : ""}` : ""}
        </button>
      </section>
    </>
  );
}

/** Shrink a photo on the device to 1280 px JPEG (~150–300 KB) before it's sent with the ticket. */
async function shrink(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.72);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Photos as a drop zone: drag photos in, "Select photos" from the library, or "Take photo" with the camera (phones
 * and iPads). Up to 6, shrunk on the device, shown as thumbnails with ×, sent as `photo` with the ticket.
 */
function PhotoAdd() {
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const full = photos.length >= 6;

  async function onFiles(files: FileList | File[] | null) {
    if (!files || !files.length) return;
    setBusy(true);
    const out: string[] = [];
    for (const f of [...files].slice(0, 6 - photos.length)) {
      if (!f.type.startsWith("image/")) continue;
      try { out.push(await shrink(f)); } catch { /* skip a photo the browser can't read */ }
    }
    setPhotos((p) => [...p, ...out].slice(0, 6));
    setBusy(false);
    if (pick.current) pick.current.value = "";
    if (camera.current) camera.current.value = "";
  }

  return (
    <div className="mt-3">
      <p className="mb-1.5 text-sm font-semibold">Photos</p>
      {!full && (
        <div
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(e.dataTransfer.files); }}
          className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors max-lg:border-0 max-lg:bg-transparent max-lg:p-0 ${over ? "border-[#c2410c] bg-[#fff1e8]" : "border-[#cfcbc4] bg-[#f7f6f3]"}`}
        >
          <div className="hidden lg:block">
            <p className="font-semibold">{busy ? "Adding…" : "Drag and drop or select photos"}</p>
            <p className="mt-0.5 text-xs text-muted">Photos from the camera or library · up to 6 · videos once file storage is on</p>
          </div>
          <div className="flex w-full flex-wrap justify-center gap-2 max-lg:grid max-lg:grid-cols-2">
            <label className="inline-flex min-h-11 justify-center cursor-pointer items-center gap-2 rounded-lg border border-[#cfcbc4] bg-card px-4 text-sm font-semibold">
              <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>
              {busy ? "Adding…" : "Select photos"}
              <input ref={pick} type="file" accept="image/*" multiple className="sr-only" onChange={(e) => onFiles(e.target.files)} />
            </label>
            <label className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-[#cfcbc4] bg-card px-4 text-sm font-semibold sm:hidden">
              <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
              Take photo
              <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => onFiles(e.target.files)} />
            </label>
          </div>
        </div>
      )}
      {photos.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {photos.map((src, i) => (
            <span key={i} className="relative">
              <input type="hidden" name="photo" value={src} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={`Photo ${i + 1}`} className="h-20 w-20 rounded-lg object-cover" />
              <button type="button" onClick={() => setPhotos((p) => p.filter((_, j) => j !== i))} aria-label={`Remove photo ${i + 1}`} className="absolute -top-2 -right-2 h-7 w-7 rounded-full bg-[#17181a] text-sm text-white">×</button>
            </span>
          ))}
          {full && <p className="self-center text-xs text-muted">6 photos is the most per ticket.</p>}
        </div>
      )}
    </div>
  );
}

/**
 * A tile on the right: tap it to add one. Once added it gets a dark border and a − n + in its corner (separate
 * buttons, not inside the tap target) so the quantity can be set from the tile as well as from the ticket.
 */
function Tile({ name, sub, qty, onAdd, onStep, muted = false }: { name: string; sub: string; qty: number; onAdd: () => void; onStep: (by: number) => void; muted?: boolean }) {
  return (
    // Picked: forest edge with a crest-yellow glow (the screen's one accent; orange stays on the button).
    <div className={`relative rounded-xl border ${qty ? "border-2 border-[#015d47] bg-[#fbfee8] shadow-[0_0_0_4px_rgba(224,243,84,0.8)]" : `border-border ${muted ? "bg-[#f7f6f3]" : "bg-card"}`}`}>
      <button type="button" onClick={onAdd} aria-label={qty ? `Add another ${name}` : `Add ${name}`} className="flex min-h-24 w-full flex-col justify-between p-3 text-left">
        <span className="line-clamp-2 font-bold">{name}</span>
        <span className={`text-sm text-muted ${qty ? "pr-24" : ""}`}>{sub}</span>
      </button>
      {qty > 0 && (
        <div className="absolute right-2 bottom-2 flex items-center rounded-full bg-[#015d47] text-white" role="group" aria-label={`${name} quantity`}>
          <button type="button" onClick={() => onStep(-1)} aria-label={`One less ${name}`} className="h-8 w-8 rounded-full text-base font-bold hover:bg-white/15">−</button>
          <span className="w-5 text-center text-sm font-bold tabular-nums" aria-live="polite">{qty}</span>
          <button type="button" onClick={() => onStep(1)} aria-label={`One more ${name}`} className="h-8 w-8 rounded-full text-base font-bold hover:bg-white/15">+</button>
        </div>
      )}
    </div>
  );
}

type ServiceDay = { date: string; label: string; slots: { iso: string; time: string; label: string }[] };

const WEEK = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "YYYY-MM-DD" plus n days, as plain calendar maths. */
function plusDays(d: string, n: number): string {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day + n)).toISOString().slice(0, 10);
}
const weekdayOf = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();

/**
 * The open days as small wheels, one month at a time (like the booking calendar); tap a day for its times, tap a
 * time to schedule the service then.
 */
function DayCalendar({ days, value, onPick }: { days: ServiceDay[]; value: string; onPick: (iso: string) => void }) {
  const picked = days.find((d) => d.slots.some((sl) => sl.iso === value));
  const [open, setOpen] = useState<string | null>(picked?.date ?? null);
  const months = [...new Set(days.map((d) => d.date.slice(0, 7)))];
  const [month, setMonth] = useState(() => (picked?.date ?? days[0].date).slice(0, 7));
  const at = Math.max(0, months.indexOf(month));
  const byDate = new Map(days.map((d) => [d.date, d]));
  const first = `${month}-01`;
  const cells: string[] = [];
  for (let d = plusDays(first, -weekdayOf(first)); d.slice(0, 7) <= month; d = plusDays(d, 1)) cells.push(d);
  while (cells.length % 7) cells.push(plusDays(cells[cells.length - 1], 1));
  const day = open ? byDate.get(open) : undefined;
  return (
    <div className="mt-3 rounded-xl border border-border bg-card p-3">
      <div className="mb-1 flex items-center justify-between">
        <button type="button" disabled={at === 0} onClick={() => setMonth(months[at - 1])} aria-label="Previous month" className="h-8 w-8 rounded-full text-lg hover:bg-[#f7f6f3] disabled:opacity-30">‹</button>
        <p className="text-sm font-bold">{MONTHS[Number(month.slice(5)) - 1]} {month.slice(0, 4)}</p>
        <button type="button" disabled={at >= months.length - 1} onClick={() => setMonth(months[at + 1])} aria-label="Next month" className="h-8 w-8 rounded-full text-lg hover:bg-[#f7f6f3] disabled:opacity-30">›</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold text-muted">{WEEK.map((w, i) => <span key={i}>{w}</span>)}</div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((d) => {
          if (d.slice(0, 7) !== month) return <span key={d} />;
          const has = byDate.has(d);
          const on = d === open;
          const chosen = d === picked?.date;
          return has ? (
            <button key={d} type="button" onClick={() => setOpen(on ? null : d)} aria-pressed={on} aria-label={byDate.get(d)!.label} className="group relative mx-auto flex h-10 w-10 items-center justify-center text-sm font-semibold" style={{ color: on || chosen ? "#fff" : ACCENT }}>
              <Wheel accent={ACCENT} selected={on || chosen} />
              <span className="relative">{Number(d.slice(8))}</span>
            </button>
          ) : (
            <span key={d} className="mx-auto flex h-10 w-10 items-center justify-center text-sm text-[#cfcbc4]">{Number(d.slice(8))}</span>
          );
        })}
      </div>
      {day && (
        <div className="mt-3 border-t border-border pt-3">
          <p className="mb-2 text-sm font-bold">{day.label}</p>
          <div className="grid grid-cols-3 gap-1.5">
            {day.slots.map((sl) => (
              <button key={sl.iso} type="button" onClick={() => onPick(sl.iso)} aria-pressed={sl.iso === value} className={`rounded-lg border py-2 text-sm font-semibold ${sl.iso === value ? "border-[#c2410c] bg-[#c2410c] text-white" : "border-[#c2410c] text-[#9a3412] hover:bg-[#fff1e8]"}`}>
                {sl.time}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The calendar as a modal: a native dialog, so Esc closes it; a click on the backdrop closes it too. */
function CalendarModal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }} aria-label="Pick a day" className="m-auto w-[min(380px,calc(100vw-32px))] rounded-2xl bg-transparent p-0 backdrop:bg-black/40 max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none">
      <div className="rounded-2xl bg-card p-4 shadow-xl max-sm:rounded-b-none max-sm:pb-6">
        <div className="flex items-center justify-between">
          <p className="text-base font-bold">Schedule service</p>
          <button type="button" onClick={() => ref.current?.close()} aria-label="Close" className="h-8 w-8 rounded-full text-xl leading-none hover:bg-[#f7f6f3]">×</button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

function CalendarIcon() {
  return (
    <svg className="shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

/** One schedule choice: a title and the time under it. */
function DropButton({ on, onClick, title, sub }: { on: boolean; onClick: () => void; title: React.ReactNode; sub: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onClick} className={`min-h-12 min-w-0 rounded-lg border px-2.5 py-1.5 text-left lg:px-3 ${on ? "border-[#015d47] bg-[#015d47] text-white" : "border-border bg-card"}`}>
      <span className="block text-sm font-bold">{title}</span>
      <span className={`block text-xs ${on ? "text-white/75" : "text-muted"}`}>{sub}</span>
    </button>
  );
}
