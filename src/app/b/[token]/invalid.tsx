import { Card } from "@/components/ui";
import type { ShowroomCtx } from "@/lib/showroom";

export function InvalidToken({ showroom }: { showroom: ShowroomCtx }) {
  return (
    <Card title="We couldn't find that pickup link">
      <p className="text-sm text-muted">
        The link may have expired or been copied incompletely. Please call {showroom.name} on{" "}
        <a className="font-medium text-accent underline" href={`tel:${showroom.phone ?? ""}`}>
          {showroom.phone ?? "the showroom"}
        </a>{" "}
        and we&apos;ll sort it out.
      </p>
    </Card>
  );
}
