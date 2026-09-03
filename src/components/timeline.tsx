import type { Event } from "@/db/schema";
import { titleCase } from "@/lib/format";
import { formatDateTime } from "@/lib/time";
import { Badge } from "./ui";

function describe(e: Event): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "extension_granted":
      return `Extended ${p.days} days (#${p.extension_number}) — ${p.reason}`;
    case "storage_waived":
      return `Waived $${((p.amount_cents as number) / 100).toFixed(2)} — ${p.reason}`;
    case "storage_collected":
      return `Collected $${((p.amount_cents as number) / 100).toFixed(2)}`;
    case "unit_detached":
      return `Detached (${p.reason})${p.staff_reason ? ` — ${p.staff_reason}` : ""}${p.customer_agreed ? " · customer agreed" : ""}`;
    case "no_show":
      return `No-show #${p.no_show_count}${p.reason === "late_change" ? " (late change)" : ""}`;
    case "booking_cancelled":
      return `Cancelled (${p.reason})`;
    case "settings_changed":
      return `Settings: ${Object.keys((p.changes as Record<string, unknown>) ?? {}).join(", ")}`;
    default:
      if (e.type.startsWith("msg_")) return String(p.metric ?? e.type);
      return "";
  }
}

export function Timeline({ events, tz }: { events: Event[]; tz: string }) {
  if (events.length === 0) return <p className="text-sm text-muted">No events yet.</p>;
  return (
    <ol className="space-y-2">
      {events.map((e) => {
        const isMsg = e.type.startsWith("msg_");
        return (
          <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border pb-2 text-sm last:border-0">
            <time className="w-52 shrink-0 text-xs text-muted">{formatDateTime(e.createdAt, tz)}</time>
            <span className="font-medium">{isMsg ? "Message" : titleCase(e.type)}</span>
            {isMsg && e.klaviyoStatus && <Badge tone={e.klaviyoStatus === "sent" ? "ok" : "danger"}>{e.klaviyoStatus}</Badge>}
            <span className="text-muted">{describe(e)}</span>
            <span className="ml-auto text-xs text-muted">{e.actor === "system" || e.actor === "customer" ? e.actor : "staff"}</span>
          </li>
        );
      })}
    </ol>
  );
}
