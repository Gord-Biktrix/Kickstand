"use client";

import { useEffect, useState } from "react";

/**
 * Header checkbox + live count for a list whose row checkboxes are `<input name="unit_ids" form="bulk">`.
 * Plain DOM listeners so the rows stay server-rendered; the bulk form itself is ordinary HTML.
 */
export function BulkSelect({ total }: { total: number }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const boxes = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[name="unit_ids"]'));
    const update = () => setCount(boxes().filter((b) => b.checked).length);
    const all = boxes();
    all.forEach((b) => b.addEventListener("change", update));
    update();
    return () => all.forEach((b) => b.removeEventListener("change", update));
  }, [total]);
  const toggleAll = (checked: boolean) => {
    document.querySelectorAll<HTMLInputElement>('input[name="unit_ids"]').forEach((b) => { b.checked = checked; });
    setCount(checked ? total : 0);
  };
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" className="h-4 w-4" aria-label="Select all" checked={total > 0 && count === total} onChange={(e) => toggleAll(e.target.checked)} />
      <span className="text-muted">{count === 0 ? "Select bikes for a bulk action" : `${count} selected`}</span>
    </label>
  );
}
