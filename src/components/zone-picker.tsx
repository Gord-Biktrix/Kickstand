"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Point the page at another zone: drops the picked day and time, which are labelled in the old zone. */
function zoneUrl(tz: string, keepSelection = false): string {
  const url = new URL(window.location.href);
  url.searchParams.set("tz", tz);
  if (!keepSelection) {
    url.searchParams.delete("date");
    url.searchParams.delete("time");
    url.searchParams.delete("confirm");
  }
  return url.pathname + url.search;
}

/**
 * On a customer's first visit, switch the page to their browser's time zone (adds ?tz=, once). Does nothing when
 * the URL already names a zone (their own choice, or a link that carries it) or the browser is in the store's zone.
 */
export function useAutoZone(storeTz: string, keepSelection = false) {
  const router = useRouter();
  useEffect(() => {
    if (new URL(window.location.href).searchParams.has("tz")) return;
    let detected = "";
    try {
      detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {}
    if (!detected || detected === storeTz) return;
    router.replace(zoneUrl(detected, keepSelection), { scroll: false });
  }, [router, storeTz, keepSelection]);
}

/** For pages that only show times (the manage page): switch to the customer's zone, no picker. */
export function ZoneAuto({ storeTz }: { storeTz: string }) {
  useAutoZone(storeTz, true);
  return null;
}

/** "Times are shown in [zone ▾]" under the calendar. Detects the customer's zone on first visit. */
export function ZonePicker({ current, storeTz, choices }: { current: string; storeTz: string; choices: { tz: string; label: string }[] }) {
  const router = useRouter();
  useAutoZone(storeTz);
  return (
    <label className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted">
      <span>Times are shown in</span>
      <select value={current} onChange={(e) => router.replace(zoneUrl(e.target.value), { scroll: false })} aria-label="Time zone" className="rounded-md border border-border bg-card px-1.5 py-1 text-xs text-foreground">
        {choices.map((c) => <option key={c.tz} value={c.tz}>{c.label}</option>)}
      </select>
    </label>
  );
}
