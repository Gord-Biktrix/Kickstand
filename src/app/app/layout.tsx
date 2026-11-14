import { Suspense } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { NavLinks } from "@/components/nav-links";
import { SectionTabs } from "@/components/section-tabs";
import { PendingIndicator } from "@/components/pending-indicator";
import { KickstandLogo } from "@/components/logo";
import { ShowroomSwitcher } from "@/components/showroom-switcher";
import { db } from "@/db/client";
import { canSwitchShowroom, currentShowroom, readOnlyReason } from "@/lib/current-showroom";
import { listShowrooms } from "@/lib/showroom";
import { hasRole, PASSWORD_NUDGE_COOKIE, requireUser, roleLabel } from "@/lib/auth";
import { signOutAction } from "./actions";

// Three places, one question each (redesign 2026-11): who's coming in (Schedule), what's on the bench (Workshop),
// who is this (Customers). Everything else sits under "+ New" or the user menu. The older pages live inside
// these as section tabs (components/section-tabs.tsx) until the new Schedule and Workshop replace them.
// `store: true`: physical stock and the workshop, hidden for the online team.
const NAV = [
  { href: "/app", label: "Schedule", exact: true, also: ["/app/schedule", "/app/bookings"] },
  { href: "/app/workshop", label: "Workshop", store: true, also: ["/app/workshop", "/app/bikes", "/app/parts", "/app/workorders", "/app/units", "/app/orders", "/app/arrivals", "/app/build", "/app/watchlist", "/app/book"] },
  { href: "/app/search", label: "Customers", also: ["/app/search", "/app/customers"] },
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
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
          <Link href="/app" aria-label="Kickstand home" className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"><KickstandLogo size={24} onDark /></Link>
          {switchable ? (
            <ShowroomSwitcher current={showroom.slug} options={all.map((s) => ({ slug: s.slug, name: s.name }))} manageHref={hasRole(user.role, "admin") ? "/app/settings/stores" : undefined} onDark />
          ) : (
            <span className="rounded-md border border-chrome-line px-2 py-1 text-xs text-chrome-muted" title="Store">{showroom.name}</span>
          )}
          <nav aria-label="Main" className="flex flex-wrap gap-x-6 gap-y-1 text-[15px]">
            <NavLinks
              variant="chrome"
              items={NAV.filter((n) => !(showroom.kind === "online" && "store" in n)).map((n) => ({
                href: n.href,
                label: n.label,
                exact: "exact" in n && n.exact,
                also: [...n.also],
              }))}
            />
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <form action="/app/search" role="search">
              <input name="q" type="search" placeholder="Search people, bikes, sale #" aria-label="Search customers" className="h-9 w-44 rounded-md border border-chrome-line bg-chrome-2 px-3 text-sm text-white placeholder:text-chrome-muted focus:outline-2 focus:outline-offset-1 focus:outline-action sm:w-64" />
            </form>
            <Link href="/app/bookings/new" className="btn btn-primary h-9 py-0">+ New</Link>
            <details className="relative">
              <summary aria-label="Your menu" className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-md border border-chrome-line bg-chrome-2 text-xs font-semibold text-white hover:bg-chrome-line [&::-webkit-details-marker]:hidden">
                {initials(user.name)}
              </summary>
              <div className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-lg border border-border bg-card text-sm text-foreground shadow-lg">
                <div className="border-b border-border px-4 py-3">
                  <p className="font-semibold">{user.name}</p>
                  <p className="text-xs text-muted">{roleLabel(user.role)} · {showroom.name}</p>
                </div>
                <nav aria-label="Your menu" className="flex flex-col py-1">
                  {hasRole(user.role, "manager") && <Link href="/app/settings/booking-types" className="px-4 py-2 hover:bg-background">Settings</Link>}
                  {hasRole(user.role, "admin") && <Link href="/app/reports" className="px-4 py-2 hover:bg-background">Reports</Link>}
                  <Link href="/app/account" className="px-4 py-2 hover:bg-background">Your account</Link>
                  <form action={signOutAction} className="border-t border-border"><button type="submit" className="w-full px-4 py-2 text-left hover:bg-background">Sign out</button></form>
                </nav>
              </div>
            </details>
          </div>
        </div>
      </header>
      <SectionTabs store={showroom.kind !== "online"} />
      {viewOnly && (
        <div className="border-b border-border bg-warn-soft">
          <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm text-warn">
            <span>{viewOnly}</span>
            {homeSlug && <a href={`/app/switch?showroom=${homeSlug}&next=/app`} className="font-medium underline">Back to my store</a>}
          </div>
        </div>
      )}
      {nudgePassword && (
        <div className="border-b border-border bg-accent-soft">
          <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm">
            <span>Signed in with Google. Want a password too, for shared shop computers?</span>
            <Link href="/app/account" className="font-medium text-accent underline">Set a password</Link>
            <form action="/app/account/dismiss" method="post" className="ml-auto"><button type="submit" className="text-xs text-muted hover:text-foreground">Not now</button></form>
          </div>
        </div>
      )}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
}
