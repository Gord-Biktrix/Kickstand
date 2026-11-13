import { Suspense } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { NavLinks } from "@/components/nav-links";
import { PendingIndicator } from "@/components/pending-indicator";
import { KickstandLogo } from "@/components/logo";
import { ShowroomSwitcher } from "@/components/showroom-switcher";
import { db } from "@/db/client";
import { canSwitchShowroom, currentShowroom, readOnlyReason } from "@/lib/current-showroom";
import { listShowrooms } from "@/lib/showroom";
import { hasRole, PASSWORD_NUDGE_COOKIE, requireUser, roleLabel } from "@/lib/auth";
import { signOutAction } from "./actions";

// Named after the questions staff ask, not the process steps: what's today, when is everything booked,
// where is every bike, who is this customer. Receiving a box, the build board and the alerts live inside Bikes.
// `store: true` items are about physical stock (bikes, parts, Lightspeed work orders): hidden for the online team.
const NAV = [
  { href: "/app", label: "Today", min: "staff", exact: true },
  { href: "/app/schedule", label: "Appointments", min: "staff" },
  { href: "/app/bikes", label: "Bikes", min: "staff", store: true },
  { href: "/app/parts", label: "Parts", min: "staff", store: true },
  { href: "/app/workorders", label: "Work orders", min: "staff", store: true },
  { href: "/app/search", label: "Customers", min: "staff" },
  { href: "/app/settings", label: "Settings", min: "manager" },
] as const;

export const metadata = { title: { default: "Kickstand", template: "%s · Kickstand" } };

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser("staff");
  const [showroom, all] = await Promise.all([currentShowroom(user), listShowrooms(db)]);
  // Everyone can look at any store; admins also get "Add/Manage stores…" so the pill is never a dead end.
  const switchable = canSwitchShowroom(user) && (all.length > 1 || hasRole(user.role, "admin"));
  const viewOnly = readOnlyReason(user, showroom, all.find((s) => s.id === user.showroomId) ?? null);
  const homeSlug = all.find((s) => s.id === user.showroomId)?.slug;
  // First-run nudge: people land here via Google/link and don't know a password is optional and where it lives.
  const nudgePassword = !user.passwordHash && !(await cookies()).get(PASSWORD_NUDGE_COOKIE);
  return (
    <div className="flex flex-1 flex-col">
      <Suspense fallback={null}><PendingIndicator /></Suspense>
      <header className="bg-chrome text-white">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/app" aria-label="Kickstand home" className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"><KickstandLogo size={24} onDark /></Link>
          {switchable ? (
            <ShowroomSwitcher current={showroom.slug} options={all.map((s) => ({ slug: s.slug, name: s.name }))} manageHref={hasRole(user.role, "admin") ? "/app/settings/stores" : undefined} onDark />
          ) : (
            <span className="rounded-md border border-chrome-line px-2 py-1 text-xs text-chrome-muted" title="Store">{showroom.name}</span>
          )}
          <nav aria-label="Main" className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <NavLinks
              variant="chrome"
              items={NAV.filter((n) => hasRole(user.role, n.min) && !(showroom.kind === "online" && "store" in n)).map((n) => ({
                href: n.href === "/app/settings" ? (showroom.kind === "online" ? "/app/settings/booking-types" : "/app/settings/capacity") : n.href,
                match: n.href === "/app/settings" ? "/app/settings" : undefined,
                label: n.label,
                exact: "exact" in n && n.exact,
              }))}
            />
          </nav>
          <form action="/app/search" role="search" className="ml-auto">
            <input name="q" type="search" placeholder="Search customers" aria-label="Search customers" className="h-8 w-44 rounded-md border border-chrome-line bg-chrome-2 px-3 text-sm text-white placeholder:text-chrome-muted focus:outline-2 focus:outline-offset-1 focus:outline-action sm:w-56" />
          </form>
          <div className="flex items-center gap-3 text-xs text-chrome-muted">
            {hasRole(user.role, "admin") && <Link href="/app/reports" className="hover:text-white">Reports</Link>}
            <Link href="/app/account" className="hidden hover:text-white sm:inline" title="Your account">{user.name} · {roleLabel(user.role)}</Link>
            <form action={signOutAction}><button type="submit" className="rounded-md border border-chrome-line bg-chrome-2 px-3 py-1.5 text-xs font-medium text-white hover:bg-chrome-line">Sign out</button></form>
          </div>
        </div>
      </header>
      {viewOnly && (
        <div className="border-b border-border bg-warn-soft">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm text-warn">
            <span>{viewOnly}</span>
            {homeSlug && <a href={`/app/switch?showroom=${homeSlug}&next=/app`} className="font-medium underline">Back to my store</a>}
          </div>
        </div>
      )}
      {nudgePassword && (
        <div className="border-b border-border bg-accent-soft">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm">
            <span>Signed in with Google. Want a password too, for shared shop computers?</span>
            <Link href="/app/account" className="font-medium text-accent underline">Set a password</Link>
            <form action="/app/account/dismiss" method="post" className="ml-auto"><button type="submit" className="text-xs text-muted hover:text-foreground">Not now</button></form>
          </div>
        </div>
      )}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
