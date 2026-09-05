"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Feedback for every form submit in the staff app: the pressed button dims and shows a spinner, and a
 * thin progress bar runs along the top until the page changes. Works for server actions and plain GET
 * filters alike — no per-button wiring. Every action redirects with a flash, so the URL always changes
 * on completion; a 60s fallback clears a stuck state (matches the Vercel maxDuration).
 */
export function PendingIndicator() {
  const [busy, setBusy] = useState(false);
  const pathname = usePathname();
  const search = useSearchParams();
  const buttons = useRef<HTMLButtonElement[]>([]);

  useEffect(() => {
    const onSubmit = (e: Event) => {
      const ev = e as SubmitEvent;
      if (ev.defaultPrevented) return;
      const submitter = ev.submitter as HTMLButtonElement | null;
      setBusy(true);
      if (submitter && submitter.tagName === "BUTTON") {
        submitter.setAttribute("aria-busy", "true");
        buttons.current.push(submitter);
        // Disable after the submission has started; disabling synchronously would drop the button's value.
        setTimeout(() => { submitter.disabled = true; }, 0);
      }
    };
    document.addEventListener("submit", onSubmit, true);
    return () => document.removeEventListener("submit", onSubmit, true);
  }, []);

  useEffect(() => {
    // Any navigation (the action's redirect) ends the pending state.
    setBusy(false);
    for (const b of buttons.current) { b.disabled = false; b.removeAttribute("aria-busy"); }
    buttons.current = [];
  }, [pathname, search]);

  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => {
      setBusy(false);
      for (const b of buttons.current) { b.disabled = false; b.removeAttribute("aria-busy"); }
      buttons.current = [];
    }, 60_000);
    return () => clearTimeout(t);
  }, [busy]);

  return busy ? (
    <div role="status" aria-live="polite" aria-label="Working…" className="pending-bar" />
  ) : null;
}
