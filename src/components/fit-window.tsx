"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A grid that fills the rest of the window on laptops and iPads (≥1024 px), like New ticket: its columns scroll
 * on their own, so buttons at the foot of a column stay in view. Narrower screens scroll as a normal page.
 */
export function FitWindow({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wide = window.matchMedia("(min-width: 1024px)");
    const fit = () => {
      if (!wide.matches) { el.style.height = ""; el.style.gridTemplateRows = ""; return; }
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.height = `${Math.max(480, window.innerHeight - top - 24)}px`;
      el.style.gridTemplateRows = "minmax(0, 1fr)";
    };
    fit();
    window.addEventListener("resize", fit);
    wide.addEventListener("change", fit);
    return () => { window.removeEventListener("resize", fit); wide.removeEventListener("change", fit); };
  }, []);
  return <div ref={ref} className={className}>{children}</div>;
}
