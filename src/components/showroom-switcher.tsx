"use client";

import { usePathname } from "next/navigation";

/**
 * Header store picker. A plain GET form to /app/switch (a route handler that sets the cookie and
 * redirects), submitted on change — a full navigation on purpose, so every server component re-reads
 * the cookie.
 */
export function ShowroomSwitcher({ current, options }: { current: string; options: { slug: string; name: string }[] }) {
  const pathname = usePathname() || "/app";
  return (
    <form action="/app/switch" method="get" className="flex items-center">
      <input type="hidden" name="next" value={pathname} />
      <select
        name="showroom"
        aria-label="Showroom"
        className="input h-8 w-auto py-0 text-sm"
        defaultValue={current}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        {options.map((o) => (
          <option key={o.slug} value={o.slug}>{o.name}</option>
        ))}
      </select>
    </form>
  );
}
