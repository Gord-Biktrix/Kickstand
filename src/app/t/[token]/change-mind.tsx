"use client";

import { useState } from "react";

/**
 * "Changed your mind?" on an answered finding: opens the same Yes / No pair with their current answer picked, and
 * Confirm (only once they pick the other one). Cancel puts it back.
 */
export function ChangeMind({ action, current, price }: { action: () => void; current: "approved" | "declined"; price: string }) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState(current);
  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="min-h-11 w-full rounded-xl border border-[#cfcbc4] bg-white font-bold">Changed your mind?</button>;
  }
  const changed = pick !== current;
  const opt = (value: "approved" | "declined", text: string) => (
    <button
      type="button"
      onClick={() => setPick(value)}
      aria-pressed={pick === value}
      className={`flex min-h-12 items-center justify-center rounded-xl border font-bold ${pick === value ? (value === "approved" ? "border-2 border-[#015d47] bg-[#015d47] text-white" : "border-2 border-[#17181a] bg-[#f3f0ea]") : "border-[#cfcbc4] bg-white"}`}
    >
      {text}
    </button>
  );
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[#cfcbc4] bg-white p-3">
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Your answer">
        {opt("approved", "Yes, fix it")}
        {opt("declined", "Not this time")}
      </div>
      {changed && <p className="text-sm">{pick === "approved" ? `${price} goes on your repair.` : "We'll take it off your repair."}</p>}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => { setPick(current); setOpen(false); }} className="min-h-11 rounded-xl border border-[#cfcbc4] font-bold">Cancel</button>
        <form action={action}>
          <button type="submit" disabled={!changed} className="min-h-11 w-full rounded-xl bg-[#17181a] font-bold text-white disabled:opacity-40">Confirm</button>
        </form>
      </div>
    </div>
  );
}
