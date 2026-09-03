import { Badge } from "./ui";

const MAP: Record<string, { label: string; tone: "neutral" | "accent" | "ok" | "warn" | "danger" }> = {
  received: { label: "Received", tone: "neutral" },
  invited: { label: "Invited", tone: "accent" },
  booked: { label: "Booked", tone: "ok" },
  building: { label: "Building", tone: "warn" },
  ready: { label: "Ready", tone: "ok" },
  picked_up: { label: "Picked up", tone: "neutral" },
  unassigned: { label: "Unassigned", tone: "danger" },
  open: { label: "Open", tone: "accent" },
  deferred: { label: "Deferred", tone: "warn" },
  fulfilled: { label: "Fulfilled", tone: "ok" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  completed: { label: "Completed", tone: "ok" },
  no_show: { label: "No-show", tone: "danger" },
};

export function StatusBadge({ status }: { status: string }) {
  const m = MAP[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}
