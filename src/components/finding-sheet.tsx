"use client";

/**
 * The "+" sheet on the job page: what the mechanic found outside the booked job. Pick what it needs (the store's
 * service tiles, or any Lightspeed item by search), add photos, say why, and how strongly it's recommended. "Add
 * another" saves it and opens a fresh sheet; "Send" saves it and sends every finding on the job to the customer.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LEVELS, type Level } from "@/lib/finding-levels";
import { LevelMeter } from "./level-meter";
import { PhotoAdd } from "./ticket-pos";

type Pick = { itemId: string; name: string; price: number | null; minutes: number | null; qty: number };
type Tile = { itemId: string; name: string; price: number | null; minutes: number | null };

const money = (n: number) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n);
const label = "text-[11px] font-extrabold tracking-wider text-[#3d3f43] uppercase";

export function FindingSheet({ action, close, first, tiles, drafts, about = "" }: { action: (fd: FormData) => void; close: string; first: string; tiles: Tile[]; drafts: number; about?: string }) {
  const [picks, setPicks] = useState<Pick[]>([]);
  const [level, setLevel] = useState<Level | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Tile[]>([]);
  const [searchNote, setSearchNote] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) return;
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/parts?q=${encodeURIComponent(q.trim())}`, { cache: "no-store" });
        const j = (await r.json()) as { parts: { itemId: string; name: string; price: number | null }[]; error?: string };
        setFound(j.parts.map((p) => ({ ...p, minutes: null })));
        setSearchNote(j.error ?? (j.parts.length ? "" : "Nothing in Lightspeed matches."));
      } catch {
        setSearchNote("Lightspeed couldn't be searched. Try again.");
      }
    }, 250);
  }, [q]);

  const add = (t: Tile) => setPicks((p) => (p.some((x) => x.itemId === t.itemId) ? p.map((x) => (x.itemId === t.itemId ? { ...x, qty: x.qty + 1 } : x)) : [...p, { ...t, qty: 1 }]));
  const qty = (id: string, d: number) => setPicks((p) => p.flatMap((x) => (x.itemId !== id ? [x] : x.qty + d <= 0 ? [] : [{ ...x, qty: x.qty + d }])));
  const total = picks.reduce((s, p) => s + (p.price ?? 0) * p.qty, 0);
  const minutes = picks.reduce((s, p) => s + (p.minutes ?? 0), 0);
  const picked = new Set(picks.map((p) => p.itemId));

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="finding-title" className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-3 sm:p-6">
      <form action={action} className="flex w-full max-w-5xl flex-col gap-4 rounded-2xl bg-[#f7f6f3] p-4 shadow-xl sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 id="finding-title" className="text-xl font-extrabold">Found something extra</h2>
          <Link href={close} aria-label="Close" className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-lg">×</Link>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="flex flex-col gap-3 rounded-xl bg-white p-4">
            <p className={label}>1 · What it needs</p>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Lightspeed items…" className="input" aria-label="Search Lightspeed items" />
            {q.trim().length >= 2 && searchNote && <p className="text-sm text-muted">{searchNote}</p>}
            <div className="grid grid-cols-2 gap-2">
              {(q.trim().length >= 2 ? found : tiles).map((t) => (
                <button key={t.itemId} type="button" onClick={() => add(t)} className={`flex min-h-16 flex-col justify-between rounded-xl border p-2.5 text-left ${picked.has(t.itemId) ? "border-2 border-[#015d47] bg-[#fbfee8] shadow-[0_0_0_4px_rgba(224,243,84,.75)]" : "border-border bg-white"}`}>
                  <span className="line-clamp-2 text-sm font-bold">{t.name}</span>
                  <span className="text-xs text-muted">{[t.price !== null ? money(t.price) : null, t.minutes ? `${t.minutes} min` : null].filter(Boolean).join(" · ")}</span>
                </button>
              ))}
            </div>
            {picks.length > 0 && (
              <ul className="flex flex-col divide-y divide-[#f1efeb] border-t border-border pt-1">
                {picks.map((p) => (
                  <li key={p.itemId} className="flex items-center gap-2 py-2 text-sm">
                    <input type="hidden" name="part" value={`${p.itemId}|${p.qty}|${p.price ?? ""}|${p.minutes ?? ""}|${p.name}`} />
                    <span className="min-w-0 flex-1 truncate font-semibold">{p.name}</span>
                    <button type="button" onClick={() => qty(p.itemId, -1)} aria-label={`One less ${p.name}`} className="h-9 w-9 rounded-lg border border-border">−</button>
                    <span className="w-6 text-center">{p.qty}</span>
                    <button type="button" onClick={() => qty(p.itemId, 1)} aria-label={`One more ${p.name}`} className="h-9 w-9 rounded-lg border border-border">+</button>
                    <span className="w-20 text-right">{p.price !== null ? money(p.price * p.qty) : "—"}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="flex flex-col gap-4">
            <section className="flex flex-col gap-2 rounded-xl bg-white p-4">
              <p className={label}>2 · Show {first}</p>
              <PhotoAdd />
            </section>
            <section className="flex flex-col gap-2 rounded-xl bg-white p-4">
              <label htmlFor="why" className={label}>3 · Reason for recommendation</label>
              <textarea id="why" name="why" rows={3} required defaultValue={about ? `${about} ` : undefined} className="input min-h-24" placeholder="Your rear rotor is worn past its limit, so the brakes won't stop as well in the rain." />
            </section>
            <section className="flex flex-col gap-2 rounded-xl bg-white p-4">
              <p className={label}>4 · How strongly do you recommend it?</p>
              <input type="hidden" name="level" value={level ?? ""} />
              {([1, 2, 3] as Level[]).map((l) => (
                <button key={l} type="button" onClick={() => setLevel(l)} aria-pressed={level === l} className={`flex min-h-14 items-center justify-between gap-3 rounded-xl border px-3.5 text-left ${level === l ? "border-2 border-[#015d47] bg-[#fbfee8]" : "border-border bg-white"}`}>
                  <LevelMeter level={l} size="sm" />
                  <span className="text-right text-xs text-muted">{LEVELS[l].note}</span>
                </button>
              ))}
            </section>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-4">
          <div>
            <p className="font-extrabold">{picks.length ? `${money(total)} + tax` : "Nothing picked yet"}{minutes ? ` · ${minutes} min` : ""}</p>
            <label className="mt-1 flex items-center gap-2 text-sm">
              <input type="checkbox" name="sms_consent" defaultChecked className="h-5 w-5" /> Text {first} the link
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" name="then" value="another" disabled={!picks.length || !level} className="btn min-h-12">Add another</button>
            <button type="submit" name="then" value="send" disabled={!picks.length || !level} className="btn btn-primary min-h-12">Send to {first}{drafts ? ` (${drafts + 1})` : ""}</button>
          </div>
        </div>
      </form>
    </div>
  );
}
