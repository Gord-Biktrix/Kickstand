import { db } from "@/db/client";
import { LOCATION_LABEL, type BookingLocation } from "@/lib/booking-types";
import { buildIcs } from "@/lib/ics";
import { bookingUrls, getBookingByToken } from "@/lib/type-bookings";

/** Calendar file for a booking, reached from the manage link (the token is the only key). */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const view = await getBookingByToken(db, (await params).token);
  if (!view || view.booking.status !== "booked") return new Response("Not found", { status: 404 });
  const { booking, type, showroom } = view;
  const ics = buildIcs({
    uid: booking.id,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    summary: `${type.name} · Biktrix`,
    description: `${type.name} with ${showroom.name}. Change or cancel: ${bookingUrls(booking).manage_url}`,
    location: type.location === "in_person" ? showroom.addressLine : LOCATION_LABEL[type.location as BookingLocation],
    url: bookingUrls(booking).manage_url,
  });
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="biktrix-booking.ics"`,
      "Cache-Control": "private, no-store",
    },
  });
}
