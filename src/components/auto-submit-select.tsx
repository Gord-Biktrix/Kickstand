"use client";

import type { ReactNode } from "react";

/** A <select> that submits its form as soon as the value changes — no Filter button needed. */
export function AutoSubmitSelect({ name, defaultValue, className, ariaLabel, children }: { name: string; defaultValue?: string; className?: string; ariaLabel?: string; children: ReactNode }) {
  return (
    <select name={name} defaultValue={defaultValue} className={className} aria-label={ariaLabel} onChange={(e) => e.currentTarget.form?.requestSubmit()}>
      {children}
    </select>
  );
}
