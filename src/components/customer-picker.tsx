"use client";

import { useEffect, useRef, useState } from "react";

type Match = { key: string; lsCustomerId: string | null; name: string; phone: string | null; email: string | null; source: string };
export type Picked = { value: string; name: string; sub: string };

const encode = (m: Match) => [m.lsCustomerId ?? "", m.name, m.phone ?? "", m.email ?? ""].join("|");
const subOf = (m: Pick<Match, "phone" | "email">) => [m.phone, m.email].filter(Boolean).join(" · ");

/**
 * The New ticket customer box, like Shopify POS: type a name, phone digits or email and matching customers appear
 * as you type (Kickstand's own plus Lightspeed's). Tap one and it becomes the ticket's customer, with Change to pick
 * again; or "Add … as a new customer" opens three fields. Posts as `c` (a match, or "new") plus nn / np / ne.
 */
export function CustomerPicker({ initial, initialNew, onPick }: { initial: Picked | null; initialNew: { nn: string; np: string; ne: string }; onPick?: (p: Picked | null) => void }) {
  const [picked, setPicked] = useState<Picked | null>(initial);
  const [adding, setAdding] = useState(!initial && !!(initialNew.nn || initialNew.np));
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Match[]>([]);
  const [lsFailed, setLsFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [newFields, setNewFields] = useState(initialNew);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/customers?q=${encodeURIComponent(q)}`, { cache: "no-store" });
        const json = (await res.json()) as { matches?: Match[]; lightspeedFailed?: boolean };
        if (mine !== seq.current) return;
        setResults(json.matches ?? []);
        setLsFailed(!!json.lightspeedFailed);
        setActive(0);
      } catch {
        if (mine === seq.current) setResults([]);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  function pick(m: Match) {
    const p = { value: encode(m), name: m.name, sub: subOf(m) || m.source };
    setPicked(p);
    onPick?.(p);
    setAdding(false);
    setQuery("");
    setResults([]);
  }

  function startNew() {
    const q = query.trim();
    const digits = q.replace(/\D/g, "");
    setNewFields((f) => ({ nn: f.nn || (digits.length >= 4 || q.includes("@") ? "" : q), np: f.np || (digits.length >= 4 ? q : ""), ne: f.ne || (q.includes("@") ? q : "") }));
    setAdding(true);
    setPicked(null);
    onPick?.(null);
    setResults([]);
  }

  const q = query.trim();
  const showList = !picked && !adding && q.length >= 2;
  const options = showList ? results : [];

  if (picked) {
    return (
      <div className="flex items-center gap-3 rounded-lg border-2 border-[#17181a] bg-[#f7f6f3] px-3 py-2.5">
        <input type="hidden" name="c" value={picked.value} />
        <span aria-hidden className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#17181a] text-sm font-bold text-white">
          {picked.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-bold">{picked.name}</span>
          <span className="block truncate text-xs text-muted">{picked.sub}</span>
        </span>
        <button type="button" onClick={() => { setPicked(null); onPick?.(null); setTimeout(() => input.current?.focus(), 0); }} className="btn btn-sm">Change</button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {adding ? (
        <div className="rounded-lg border-2 border-[#17181a] p-3">
          <input type="hidden" name="c" value="new" />
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-bold">New customer</span>
            <button type="button" onClick={() => setAdding(false)} className="text-sm underline">Search instead</button>
          </div>
          <div className="grid gap-2">
            <input name="nn" value={newFields.nn} onChange={(e) => setNewFields({ ...newFields, nn: e.target.value })} placeholder="Full name" aria-label="Customer's full name" className="input h-11 text-base" autoFocus />
            <input name="np" value={newFields.np} onChange={(e) => setNewFields({ ...newFields, np: e.target.value })} placeholder="Mobile" inputMode="tel" aria-label="Customer's mobile" className="input h-11 text-base" />
            <input name="ne" value={newFields.ne} onChange={(e) => setNewFields({ ...newFields, ne: e.target.value })} placeholder="Email (optional)" inputMode="email" aria-label="Customer's email" className="input h-11 text-base" />
          </div>
        </div>
      ) : (
        <div className="relative">
          <label htmlFor="cust" className="sr-only">Find a customer by name, phone or email</label>
          <input
            id="cust"
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (!showList) return;
              const total = options.length + 1; // the matches, then "Add as new"
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % total); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + total) % total); }
              else if (e.key === "Enter") { e.preventDefault(); if (active < options.length) pick(options[active]); else startNew(); }
              else if (e.key === "Escape") setQuery("");
            }}
            placeholder="Search customers: name, phone or email"
            autoComplete="off"
            role="combobox"
            aria-expanded={showList}
            aria-controls="cust-list"
            aria-autocomplete="list"
            className="input h-12 w-full text-base"
          />
          {showList && (
            <ul id="cust-list" role="listbox" aria-label="Matching customers" className="absolute top-full right-0 left-0 z-20 mt-1 max-h-80 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg">
              {loading && options.length === 0 && <li className="px-3 py-2 text-sm text-muted">Searching…</li>}
              {options.map((m, i) => (
                <li key={m.key} role="option" aria-selected={i === active}>
                  <button type="button" onMouseEnter={() => setActive(i)} onClick={() => pick(m)} className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left ${i === active ? "bg-[#f7f6f3]" : ""}`}>
                    <span aria-hidden className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#3d3f43] text-xs font-semibold text-white">
                      {m.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-semibold">{m.name}</span>
                      <span className="block truncate text-xs text-muted">{[subOf(m), m.source].filter(Boolean).join(" · ")}</span>
                    </span>
                  </button>
                </li>
              ))}
              {!loading && options.length === 0 && <li className="px-3 py-2 text-sm text-muted">No one matches &ldquo;{q}&rdquo;.</li>}
              <li role="option" aria-selected={active === options.length}>
                <button type="button" onMouseEnter={() => setActive(options.length)} onClick={startNew} className={`w-full rounded-md px-3 py-2.5 text-left text-sm font-semibold ${active === options.length ? "bg-[#f7f6f3]" : ""}`}>
                  + Add &ldquo;{q}&rdquo; as a new customer
                </button>
              </li>
              {lsFailed && <li className="px-3 pb-2 text-xs text-muted">Lightspeed&apos;s customer list didn&apos;t answer; showing Kickstand&apos;s customers.</li>}
            </ul>
          )}
          {!q && <button type="button" onClick={startNew} className="mt-2 text-sm underline">+ New customer</button>}
        </div>
      )}
    </div>
  );
}
