"use client";

import { useEffect, useState } from "react";
import { CustomerPicker, type Picked } from "./customer-picker";

type Bike = { key: string; label: string; serial: string | null; serializedId: string | null; source: string };
const label = "text-[11px] font-extrabold tracking-wider text-[#3d3f43] uppercase";

/**
 * Customer, then their bike: once a customer is picked, the bikes they have (bought here, registered in
 * Lightspeed, or on past work orders) appear as buttons, like the POS mock. Tapping one fills Bike and Serial and,
 * for a Lightspeed bike, attaches it to the work order (`sid`). "Other bike" leaves the fields for typing.
 */
export function TicketCustomerBike(props: { initial: Picked | null; initialNew: { nn: string; np: string; ne: string }; bike: string; serial: string; sid: string }) {
  const [picked, setPicked] = useState<Picked | null>(props.initial);
  const [bikes, setBikes] = useState<Bike[]>([]);
  const [loading, setLoading] = useState(false);
  const [bike, setBike] = useState(props.bike);
  const [serial, setSerial] = useState(props.serial);
  const [sid, setSid] = useState(props.sid);
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    if (!picked) return;
    const [ls, , phone, email] = picked.value.split("|");
    let live = true;
    (async () => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ ls: ls ?? "", phone: phone ?? "", email: email ?? "" });
        const res = await fetch(`/api/customers/bikes?${qs.toString()}`, { cache: "no-store" });
        const json = (await res.json()) as { bikes?: Bike[] };
        if (!live) return;
        const list = json.bikes ?? [];
        setBikes(list);
        // One bike on file: pick it, unless something was already typed.
        if (list.length === 1 && !props.bike) choose(list[0]);
      } catch {
        if (live) setBikes([]);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);

  function choose(b: Bike) {
    setChosen(b.key);
    setBike(b.label);
    setSerial(b.serial ?? "");
    setSid(b.serializedId ?? "");
  }

  function other() {
    setChosen("other");
    setBike("");
    setSerial("");
    setSid("");
  }

  return (
    <>
      <div className="flex min-w-0 flex-col gap-2">
        <p className={label}>Customer</p>
        <CustomerPicker initial={props.initial} initialNew={props.initialNew} onPick={(p) => { setPicked(p); setBikes([]); setChosen(null); }} />
      </div>

      <div className="grid gap-2">
        <label htmlFor="bike" className={label}>Bike</label>
        {picked && (loading || bikes.length > 0) && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Their bikes">
            {loading && <span className="text-sm text-muted">Looking up their bikes…</span>}
            {bikes.map((b) => (
              <button key={b.key} type="button" onClick={() => choose(b)} aria-pressed={chosen === b.key} title={b.source} className={`min-h-11 rounded-full border px-4 text-sm font-semibold ${chosen === b.key ? "border-[#17181a] bg-[#17181a] text-white" : "border-border bg-card"}`}>
                {b.label}
              </button>
            ))}
            {!loading && (
              <button type="button" onClick={other} aria-pressed={chosen === "other"} className={`min-h-11 rounded-full border px-4 text-sm font-semibold ${chosen === "other" ? "border-[#17181a] bg-[#17181a] text-white" : "border-border bg-card"}`}>+ Other bike</button>
            )}
          </div>
        )}
        <input id="bike" name="bike" value={bike} onChange={(e) => { setBike(e.target.value); setSid(""); setChosen(null); }} placeholder="e.g. Stunner Lite 3, peach" className="input h-11 text-base" />
        <input name="serial" value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="Serial (optional)" aria-label="Serial number" className="input h-11 text-base" />
        <input type="hidden" name="sid" value={sid} />
      </div>
    </>
  );
}
