import Link from "next/link";
import { NavLinks } from "@/components/nav-links";
import { ShowroomSwitcher } from "@/components/showroom-switcher";
import { db } from "@/db/client";
import { canSwitchShowroom, currentShowroom } from "@/lib/current-showroom";
import { listShowrooms } from "@/lib/showroom";
import { hasRole, requireUser } from "@/lib/auth";
import { signOutAction } from "./actions";

// Named after the questions staff ask, not the process steps: what's today, when is everything booked,
// where is every bike, who is this customer. Receiving a box, the build board and the alerts live inside Bikes.
const NAV = [
  { href: "/app", label: "Today", min: "staff", exact: true },
  { href: "/app/schedule", label: "Appointments", min: "staff" },
  { href: "/app/bikes", label: "Bikes", min: "staff" },
  { href: "/app/workorders", label: "Work orders", min: "staff" },
  { href: "/app/search", label: "Customers", min: "staff" },
  { href: "/app/settings", label: "Settings", min: "manager" },
] as const;

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser("staff");
  const [showroom, all] = await Promise.all([currentShowroom(user), listShowrooms(db)]);
  const switchable = canSwitchShowroom(user) && all.length > 1;
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/app" className="text-sm font-semibold uppercase tracking-widest text-accent">Biktrix Pickups</Link>
          {switchable ? (
            <ShowroomSwitcher current={showroom.slug} options={all.map((s) => ({ slug: s.slug, name: s.name }))} />
          ) : (
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted" title="Showroom">{showroom.name}</span>
          )}
          <nav aria-label="Main" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <NavLinks
              items={NAV.filter((n) => hasRole(user.role, n.min)).map((n) => ({
                href: n.href === "/app/settings" ? "/app/settings/capacity" : n.href,
                match: n.href === "/app/settings" ? "/app/settings" : undefined,
                label: n.label,
                exact: "exact" in n && n.exact,
              }))}
            />
          </nav>
          <form action="/app/search" role="search" className="ml-auto">
            <input name="q" type="search" placeholder="Search customers" aria-label="Search customers" className="input h-8 w-44 text-sm sm:w-56" />
          </form>
          <div className="flex items-center gap-3 text-xs text-muted">
            {hasRole(user.role, "admin") && <Link href="/app/reports" className="hover:text-accent">Reports</Link>}
            <span className="hidden sm:inline">{user.name} · {user.role}</span>
            <form action={signOutAction}><button type="submit" className="btn btn-sm">Sign out</button></form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
