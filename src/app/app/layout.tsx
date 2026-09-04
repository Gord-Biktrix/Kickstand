import Link from "next/link";
import { NavLinks } from "@/components/nav-links";
import { hasRole, requireUser } from "@/lib/auth";
import { signOutAction } from "./actions";

const NAV = [
  { href: "/app", label: "Today", min: "staff", exact: true },
  { href: "/app/schedule", label: "Schedule", min: "staff" },
  { href: "/app/arrivals", label: "Arrivals", min: "staff" },
  { href: "/app/build", label: "Build board", min: "staff" },
  { href: "/app/watchlist", label: "Watchlist", min: "staff" },
  { href: "/app/settings", label: "Settings", min: "manager" },
] as const;

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser("staff");
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/app" className="text-sm font-semibold uppercase tracking-widest text-accent">Biktrix Pickups</Link>
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
