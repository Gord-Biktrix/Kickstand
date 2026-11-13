"use client";

import { usePathname, useRouter } from "next/navigation";

/**
 * Header store picker. A plain GET form to /app/switch (a route handler that sets the cookie and
 * redirects), submitted on change — a full navigation on purpose, so every server component re-reads
 * the cookie.
 */
export function ShowroomSwitcher({ current, options, manageHref, onDark = false }: { current: string; options: { slug: string; name: string }[]; manageHref?: string; onDark?: boolean }) {
  const pathname = usePathname() || "/app";
  const router = useRouter();
  return (
    <form action="/app/switch" method="get" className="flex items-center">
      <input type="hidden" name="next" value={pathname} />
      <select
        name="showroom"
        aria-label="Showroom"
        className={onDark ? "h-8 w-auto rounded-md border border-chrome-line bg-chrome-2 px-2 py-0 text-sm font-medium text-white focus:outline-2 focus:outline-offset-1 focus:outline-action" : "input h-8 w-auto py-0 text-sm"}
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
