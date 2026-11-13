import { NavLinks } from "@/components/nav-links";
import { hasRole, requireUser, type Role } from "@/lib/auth";
import { currentShowroom } from "@/lib/current-showroom";

// `store: true` tabs only apply to a physical store (pickup capacity, the pickup program, Lightspeed views, CSV import).
const TABS: { href: string; label: string; min?: Role; store?: boolean }[] = [
  { href: "/app/settings/booking-types", label: "Booking types" },
  { href: "/app/settings/capacity", label: "Capacity", store: true },
  { href: "/app/settings/program", label: "Program", store: true },
  { href: "/app/settings/views", label: "Views", store: true },
  { href: "/app/settings/staff", label: "Staff" },
  { href: "/app/settings/import", label: "Import", store: true },
  { href: "/app/settings/stores", label: "Stores", min: "admin" },
];

/** Settings: one nav entry, a tab per area. Manager and above (each page re-checks). */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser("manager");
  const showroom = await currentShowroom(user);
  return (
    <div>
      <NavLinks items={TABS.filter((t) => (!t.min || hasRole(user.role, t.min)) && !(t.store && showroom.kind === "online")).map(({ href, label }) => ({ href, label }))} variant="tabs" />
      {children}
    </div>
  );
}
