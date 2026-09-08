import { NavLinks } from "@/components/nav-links";
import { hasRole, requireUser, type Role } from "@/lib/auth";

const TABS: { href: string; label: string; min?: Role }[] = [
  { href: "/app/settings/capacity", label: "Capacity" },
  { href: "/app/settings/program", label: "Program" },
  { href: "/app/settings/views", label: "Views" },
  { href: "/app/settings/staff", label: "Staff" },
  { href: "/app/settings/import", label: "Import" },
  { href: "/app/settings/stores", label: "Stores", min: "admin" },
];

/** Settings: one nav entry, three tabs. Manager and above (each page re-checks). */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser("manager");
  return (
    <div>
      <NavLinks items={TABS.filter((t) => !t.min || hasRole(user.role, t.min)).map(({ href, label }) => ({ href, label }))} variant="tabs" />
      {children}
    </div>
  );
}
