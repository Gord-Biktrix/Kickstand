import { NavLinks } from "@/components/nav-links";
import { requireUser } from "@/lib/auth";

const TABS = [
  { href: "/app/settings/capacity", label: "Capacity" },
  { href: "/app/settings/program", label: "Program" },
  { href: "/app/settings/views", label: "Views" },
  { href: "/app/settings/import", label: "Import" },
];

/** Settings: one nav entry, three tabs. Manager and above (each page re-checks). */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requireUser("manager");
  return (
    <div>
      <NavLinks items={TABS} variant="tabs" />
      {children}
    </div>
  );
}
