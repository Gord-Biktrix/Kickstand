import { Suspense } from "react";
import { VERSION } from "@/lib/version";
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
import { HeaderMenu } from "@/components/header-menu";
import { colorOf, ensureDefaultBookingTypes, isTicketType, listBookingTypes, typeNotEnded, LOCATION_LABEL, type BookingLocation } from "@/lib/booking-types";
import { toLocalDate } from "@/lib/time";
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
  // "+ New" lists what can be booked here, like Calendly's Create menu, so staff pick the type in one click.
  await ensureDefaultBookingTypes(db, showroom);
  const active = (await listBookingTypes(db, showroom.id)).filter((t) => t.kind === "standard" && t.active && typeNotEnded(t, toLocalDate(new Date(), showroom.timezone)));
  // Types that create a work order open New ticket (so the work order gets its lines); the rest use the booking form.
  const ticketTypes = showroom.kind === "online" ? [] : active.filter(isTicketType);
  const visitTypes = active.filter((t) => !ticketTypes.includes(t));
  const manager = hasRole(user.role, "manager");
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
            <Suspense fallback={<Link href="/app/bookings/new" className="btn btn-primary h-9 py-0">+ New</Link>}>
              <HeaderMenu label="New" summary={<>+ New <span aria-hidden="true" className="text-xs">▾</span></>} summaryClassName="btn btn-primary h-9 gap-1.5 py-0">
                <div className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-card text-sm text-foreground shadow-lg">
                  {showroom.kind !== "online" && (
                    <>
                      <p className="px-4 pt-3 pb-1 text-xs font-bold tracking-wider text-muted uppercase">Workshop</p>
                      <nav aria-label="Workshop" className="flex flex-col border-b border-border pb-2">
                        {(ticketTypes.length > 1 ? ticketTypes : [ticketTypes[0] ?? null]).map((t) => (
                          <Link key={t?.id ?? "ticket"} href={t && ticketTypes.length > 1 ? `/app/workshop/new?type=${t.id}` : "/app/workshop/new"} className="flex gap-3 px-4 py-2.5 hover:bg-background">
                            <span aria-hidden="true" className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: t ? colorOf(t.color).hex : "#17181a" }} />
                            <span>
                              <span className="block font-semibold">{ticketTypes.length > 1 && t ? t.name : "Repair ticket"}</span>
                              <span className="block text-xs text-muted">Check a bike in now, or book {t ? `a ${t.name.toLowerCase()}` : "a service"}</span>
                            </span>
                          </Link>
                        ))}
                      </nav>
                    </>
                  )}
                  {(visitTypes.length > 0 || ticketTypes.length === 0) && (<>
                  <p className="px-4 pt-3 pb-1 text-xs font-bold tracking-wider text-muted uppercase">Book a visit</p>
                  <nav aria-label="Book a visit" className="flex flex-col pb-2">
                    {visitTypes.map((t) => (
                      <Link key={t.id} href={`/app/bookings/new?type=${t.id}`} className="flex gap-3 px-4 py-2.5 hover:bg-background">
                        <span aria-hidden="true" className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: colorOf(t.color).hex }} />
                        <span>
                          <span className="block font-semibold">{t.name}</span>
                          <span className="block text-xs text-muted">{t.durationMin} min · {LOCATION_LABEL[t.location as BookingLocation]}{t.access === "invite" ? " · invite only" : ""}</span>
                        </span>
                      </Link>
                    ))}
                    {visitTypes.length === 0 && <p className="px-4 py-2 text-muted">Nothing can be booked here yet.</p>}
                  </nav>
                  </>)}
                  {showroom.kind !== "online" && (
                    <div className="border-t border-border py-2">
                      <Link href="/app/bikes?filter=not_booked" className="flex gap-3 px-4 py-2.5 hover:bg-background">
                        <span aria-hidden="true" className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-[2px] bg-[#0f766e]" />
                        <span>
                          <span className="block font-semibold">Bike pickup</span>
                          <span className="block text-xs text-muted">Pick the bike, then a time. Bikes not booked yet.</span>
                        </span>
                      </Link>
                    </div>
                  )}
                  {manager && (
                    <div className="border-t border-border bg-background/60 py-2">
                      <Link href="/app/settings/booking-types?new=1" className="block px-4 py-2 hover:bg-background">
                        <span className="block font-semibold">New visit type</span>
                        <span className="block text-xs text-muted">Something customers can book, with its own rules</span>
                      </Link>
                    </div>
                  )}
                </div>
              </HeaderMenu>
            </Suspense>
            <Suspense fallback={null}>
              <HeaderMenu label="Your menu" summary={initials(user.name)} summaryClassName="flex h-9 w-9 items-center justify-center rounded-md border border-chrome-line bg-chrome-2 text-xs font-semibold text-white hover:bg-chrome-line">
                <div className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-lg border border-border bg-card text-sm text-foreground shadow-lg">
                  <div className="border-b border-border px-4 py-3">
                    <p className="font-semibold">{user.name}</p>
                    <p className="text-xs text-muted">{roleLabel(user.role)} · {showroom.name}</p>
                  </div>
                  <nav aria-label="Your menu" className="flex flex-col py-1">
                    {manager && <Link href="/app/settings/booking-types" className="px-4 py-2 hover:bg-background">Settings</Link>}
                    {hasRole(user.role, "admin") && <Link href="/app/reports" className="px-4 py-2 hover:bg-background">Reports</Link>}
                    <Link href="/app/account" className="px-4 py-2 hover:bg-background">Your account</Link>
                    <form action={signOutAction} className="border-t border-border"><button type="submit" className="w-full px-4 py-2 text-left hover:bg-background">Sign out</button></form>
                  </nav>
                </div>
              </HeaderMenu>
            </Suspense>
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
      <footer className="mx-auto w-full max-w-7xl px-4 pb-4 text-xs text-muted">Kickstand {VERSION}</footer>
    </div>
  );
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
}
