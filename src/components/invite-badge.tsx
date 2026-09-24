import type { InviteStatus } from "@/lib/invite-status";
import { formatDateTime } from "@/lib/time";
import { Badge } from "./ui";

const ICON: Record<InviteStatus["key"], string> = { opened: "✓✓", delivered: "✓", undelivered: "✕", failed: "✕", sent: "…", none: "!" };

/** Did the customer get their invite? Hover for the detail. */
export function InviteBadge({ status, tz }: { status: InviteStatus | null | undefined; tz: string }) {
  if (!status) return null;
  const title = `${status.detail}${status.at ? ` · ${formatDateTime(status.at, tz)}` : ""}`;
  return (
    <span title={title} className="inline-flex align-middle">
      <Badge tone={status.tone}>
        <span aria-hidden className="mr-1">{ICON[status.key]}</span>
        {status.label}
        <span className="sr-only"> — {title}</span>
      </Badge>
    </span>
  );
}
