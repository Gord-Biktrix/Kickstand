"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * A header dropdown (+ New, your menu) built on <details>, so it works before JavaScript loads. The layout
 * stays mounted between pages, so this closes it after navigating, on a click outside, and on Escape.
 */
export function HeaderMenu({ summary, summaryClassName, label, children }: { summary: ReactNode; summaryClassName: string; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();
  const search = useSearchParams();

  useEffect(() => {
    ref.current?.removeAttribute("open");
  }, [pathname, search]);

  useEffect(() => {
    const close = (e: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !el.contains(e.target as Node)) {
        el.removeAttribute("open");
        if (e instanceof KeyboardEvent) el.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  return (
    <details ref={ref} className="relative">
      <summary aria-label={label} className={`cursor-pointer list-none [&::-webkit-details-marker]:hidden ${summaryClassName}`}>
        {summary}
      </summary>
      {children}
    </details>
  );
}
