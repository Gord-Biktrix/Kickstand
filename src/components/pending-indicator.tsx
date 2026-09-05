"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Feedback for every form submit in the staff app: the pressed button dims and shows a spinner, and a
 * thin progress bar runs along the top until the page changes. Works for server actions and plain GET
 * filters alike — no per-button wiring. Every action redirects with a flash, so the URL always changes
 * on completion; a 60s fallback clears a stuck state (matches the Vercel maxDuration).
 */

// Buttons marked busy, kept outside React so releasing them is a plain DOM operation.
const pendingButtons: HTMLButtonElement[] = [];
function releaseButtons() {
  for (const b of pendingButtons) {
    b.disabled = false;
    b.removeAttribute("aria-busy");
  }
  pendingButtons.length = 0;
}

export function PendingIndicator() {
  const pathname = usePathname();
  const search = useSearchParams();
  const navKey = `${pathname}?${search.toString()}`;
  // Busy while the URL is still the one the form was submitted from.
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const busy = pendingKey !== null && pendingKey === navKey;
  const navKeyRef = useRef(navKey);

  useEffect(() => {
    navKeyRef.current = navKey;
    releaseButtons();
  }, [navKey]);

  useEffect(() => {
    const onSubmit = (e: Event) => {
      const ev = e as SubmitEvent;
      if (ev.defaultPrevented) return;
      const submitter = ev.submitter as HTMLButtonElement | null;
      if (submitter && submitter.tagName === "BUTTON") {
        submitter.setAttribute("aria-busy", "true");
        pendingButtons.push(submitter);
        // Disable after the submission has started; disabling synchronously would drop the button's value.
        setTimeout(() => { submitter.disabled = true; }, 0);
      }
      setPendingKey(navKeyRef.current);
    };
    document.addEventListener("submit", onSubmit, true);
    return () => document.removeEventListener("submit", onSubmit, true);
  }, []);

  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => {
      releaseButtons();
      setPendingKey(null);
    }, 60_000);
    return () => clearTimeout(t);
  }, [busy]);

  return busy ? <div role="status" aria-live="polite" aria-label="Working…" className="pending-bar" /> : null;
}
