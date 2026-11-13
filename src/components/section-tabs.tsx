"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The sub-pages of each top-level place, as a tab row under the header. Schedule: the day list and the
 * calendar. Workshop: bikes, parts and Lightspeed work orders (until the Workshop board replaces them).
 * Shown only on those pages; detail pages (a bike, an order, a booking) keep the row for their place.
 */
const GROUPS: { tabs: { href: string; label: string; also?: string[] }[]; under: string[]; store?: boolean }[] = [
  {
    under: ["/app/schedule"],
    tabs: [
      { href: "/app", label: "Day" },
      { href: "/app/schedule", label: "Calendar" },
    ],
  },
  {
    store: true,
    under: ["/app/bikes", "/app/parts", "/app/workorders", "/app/arrivals", "/app/watchlist", "/app/build"],
    tabs: [
      { href: "/app/bikes", label: "Bikes", also: ["/app/arrivals", "/app/watchlist", "/app/build"] },
      { href: "/app/parts", label: "Parts" },
      { href: "/app/workorders", label: "Work orders" },
    ],
  },
];

export function SectionTabs({ store }: { store: boolean }) {
  const pathname = usePathname() || "/app";
  const under = (p: string) => pathname === p || pathname.startsWith(p + "/");
  const group = GROUPS.find((g) => (!g.store || store) && (pathname === "/app" ? g.tabs[0].href === "/app" : g.under.some(under)));
  if (!group) return null;
  return (
    <div className="border-b border-border bg-card">
      <nav aria-label="Section" className="mx-auto flex w-full max-w-7xl gap-1 px-4 text-sm">
        {group.tabs.map((t) => {
          const active = t.href === "/app" ? pathname === "/app" : under(t.href) || !!t.also?.some(under);
          return (
            <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined} className={`-mb-px border-b-2 px-3 py-2.5 ${active ? "border-action font-semibold text-foreground" : "border-transparent text-muted hover:text-foreground"}`}>
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
