"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** `match` widens the active test to a path prefix different from the link target (Settings → /app/settings/*). */
export type NavItem = { href: string; label: string; exact?: boolean; match?: string };

/**
 * Nav links with an active state. `exact` matches the path alone (for "/app" so it does not
 * light up on every child route); otherwise the item is active for the href and anything under it.
 */
export function NavLinks({ items, variant = "top" }: { items: NavItem[]; variant?: "top" | "tabs" }) {
  const pathname = usePathname();
  const isActive = (i: NavItem) => {
    if (i.exact) return pathname === i.href;
    if (i.match) return pathname === i.match || pathname.startsWith(i.match + "/");
    return pathname === i.href || pathname.startsWith(i.href + "/");
  };
  if (variant === "tabs") {
    return (
      <div role="tablist" className="mb-5 flex gap-1 border-b border-border text-sm">
        {items.map((i) => {
          const active = isActive(i);
          return (
            <Link key={i.href} role="tab" aria-selected={active} href={i.href} className={`-mb-px border-b-2 px-3 py-2 ${active ? "border-accent font-semibold text-accent" : "border-transparent text-muted hover:text-foreground"}`}>
              {i.label}
            </Link>
          );
        })}
      </div>
    );
  }
  return (
    <>
      {items.map((i) => {
        const active = isActive(i);
        return (
          <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined} className={`border-b-2 pb-0.5 ${active ? "border-accent font-semibold text-accent" : "border-transparent text-foreground hover:text-accent"}`}>
            {i.label}
          </Link>
        );
      })}
    </>
  );
}
