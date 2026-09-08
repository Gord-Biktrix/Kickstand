"use client";

import { usePathname, useRouter } from "next/navigation";

/**
 * Header store picker. A plain GET form to /app/switch (a route handler that sets the cookie and
 * redirects), submitted on change — a full navigation on purpose, so every server component re-reads
 * the cookie.
 */
export function ShowroomSwitcher({ current, options, manageHref }: { current: string; options: { slug: string; name: string }[]; manageHref?: string }) {
  const pathname = usePathname() || "/app";
  const router = useRouter();
  return (
    <form action="/app/switch" method="get" className="flex items-center">
      <input type="hidden" name="next" value={pathname} />
      <select
        name="showroom"
        aria-label="Showroom"
        className="input h-8 w-auto py-0 text-sm"
        defaultValue={current}
        onChange={(e) => {
          if (e.currentTarget.value === "__manage" && manageHref) {
            e.currentTarget.value = current;
            router.push(manageHref);
            return;
          }
          e.currentTarget.form?.requestSubmit();
        }}
      >
        {options.map((o) => (
          <option key={o.slug} value={o.slug}>{o.name}</option>
        ))}
        {manageHref && <option value="__manage">{options.length > 1 ? "Manage stores…" : "Add a store…"}</option>}
      </select>
    </form>
  );
}
