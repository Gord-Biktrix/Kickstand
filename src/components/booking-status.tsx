import type { Booking, BookingType } from "@/db/schema";
import { doneWords } from "@/lib/booking-types";
import { setBookingStatusAction } from "@/app/app/actions";

/**
 * Booked / Done (Checked in for visits) / No-show as one segmented control, on the booking page and on each Today
 * card. No-show waits for the start time. `back` is where the page returns after a change (defaults to the booking).
 */
export function BookingStatusControl({ booking: b, type, now, back, size = "md" }: { booking: Booking; type: BookingType; now: Date; back?: string; size?: "sm" | "md" }) {
  if (b.status === "cancelled") return null;
  const done = doneWords(type.location).action === "Check in" ? "Checked in" : "Done";
  const options = [["booked", "Booked"], ["completed", done], ["no_show", "No-show"]] as const;
  return (
    <div className={`flex overflow-hidden rounded-lg border border-border ${size === "sm" ? "text-xs" : "text-sm"}`} role="group" aria-label="Status">
      {options.map(([value, label]) => {
        const on = b.status === value;
        const early = value === "no_show" && b.startsAt > now;
        return (
          <form key={value} action={setBookingStatusAction.bind(null, b.id, value, back ?? "")} className="flex-1 border-l border-border first:border-l-0">
            <button
              type="submit"
              disabled={on || early}
              aria-pressed={on}
              title={early ? "After the start time" : undefined}
              className={`${size === "sm" ? "h-8 px-2.5" : "h-9 px-3"} w-full whitespace-nowrap font-medium ${on ? (value === "no_show" ? "bg-danger text-white" : value === "completed" ? "bg-ok text-white" : "bg-accent text-white") : early ? "cursor-not-allowed text-muted/50" : "hover:bg-background"}`}
            >
              {label}
            </button>
          </form>
        );
      })}
    </div>
  );
}
