import type { ReactNode } from "react";
import type { Host } from "@/lib/staff-photos";
import { Avatar } from "./avatar";

export { BookingCalendar, monthCells } from "./booking-calendar-picker";

/** The left panel: brand, who, what, how long, where. */
export function BookingInfo({ brand, title, durationMin, location, description, extra, hosts }: { brand: string; title: string; durationMin: number; location: string; description?: string; extra?: ReactNode; hosts?: Host[] }) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold uppercase tracking-widest text-accent">Biktrix</p>
      <p className="text-sm text-muted">{brand}</p>
      {hosts && hosts.length > 0 && <HostFaces hosts={hosts} size={52} />}
      <h1 className="text-2xl font-bold leading-tight">{title}</h1>
      <p className="flex items-center gap-2 text-sm text-muted"><ClockIcon /> {durationMin} min</p>
      <p className="flex items-center gap-2 text-sm text-muted"><PlaceIcon /> {location}</p>
      {extra}
      {description && <p className="pt-2 text-sm">{description}</p>}
    </div>
  );
}

/** The people a customer might talk to: overlapping round photos (names only for screen readers and on hover). */
export function HostFaces({ hosts, size = 52 }: { hosts: Host[]; size?: number }) {
  return (
    <div className="flex -space-x-3 pt-1" role="img" aria-label={`Our team: ${hosts.map((h) => h.name).join(", ")}`}>
      {hosts.map((h) => <span key={h.id} title={h.name}><Avatar name={h.name} photo={h.photo} size={size} className="ring-2 ring-card" /></span>)}
    </div>
  );
}

function ClockIcon() {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
}
function PlaceIcon() {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></svg>;
}
