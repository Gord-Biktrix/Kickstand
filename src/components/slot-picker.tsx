import Link from "next/link";
import { Card } from "@/components/ui";
import type { TypeDay } from "@/lib/type-slots";
import { formatLongDateFromLocal, formatShortDateFromLocal, formatTime } from "@/lib/time";

/**
 * Days with open times, then the times on the chosen day. Selection lives in the URL (?date=…&time=…), so
 * the page works without JavaScript and the back button does what people expect.
 */
export function SlotPicker({ days, base, date, tz }: { days: TypeDay[]; base: string; date?: string; tz: string }) {
  const join = base.includes("?") ? "&" : "?";
  const selected = date ? days.find((d) => d.date === date) : undefined;
  if (!days.length) {
    return <Card><p className="text-sm">No times are open right now. Please check back soon or call us.</p></Card>;
  }
  if (selected) {
    return (
      <Card title={formatLongDateFromLocal(selected.date)}>
        <ul className="grid grid-cols-3 gap-2" aria-label="Available times">
          {selected.slots.map((s) => (
            <li key={s.time}>
              <Link href={`${base}${join}date=${selected.date}&time=${s.time}`} className="btn w-full">{formatTime(s.startsAt, tz)}</Link>
            </li>
          ))}
        </ul>
        <Link href={base} className="mt-4 inline-block text-sm text-accent underline">← Another day</Link>
      </Card>
    );
  }
  return (
    <Card title="Pick a day">
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Days with open times">
        {days.map((d) => (
          <li key={d.date}>
            <Link href={`${base}${join}date=${d.date}`} className="btn h-auto w-full flex-col py-2">
              <span className="font-medium">{formatShortDateFromLocal(d.date)}</span>
              <span className="text-xs text-muted">{d.slots.length} time{d.slots.length === 1 ? "" : "s"}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
