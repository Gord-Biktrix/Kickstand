"use server";

import { countryCode } from "@/lib/country";
import { validTimeZone } from "@/lib/view-tz";
import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { bookingTypes } from "@/db/schema";
import { bool, str } from "@/lib/flash";
import { getShowroom } from "@/lib/showroom";
import { cancelTypeBooking, createTypeBooking, getBookingByToken, rescheduleTypeBooking, TypeBookingError } from "@/lib/type-bookings";

function back(path: string, err: unknown): never {
  if (err instanceof TypeBookingError) redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(err.message)}`);
  throw err;
}

/** A customer confirms a time from a profile's public booking page. */
export async function bookTypeAction(profileSlug: string, typeSlug: string, formData: FormData) {
  const showroom = await getShowroom(db, profileSlug).catch(() => null);
  if (!showroom) redirect("/");
  const [type] = await db.select().from(bookingTypes).where(and(eq(bookingTypes.showroomId, showroom.id), eq(bookingTypes.slug, typeSlug)));
  const page = `/book/${profileSlug}/${typeSlug}`;
  if (!type) redirect(`/book/${profileSlug}`);
  const startsAt = new Date(str(formData, "starts_at"));
  if (Number.isNaN(startsAt.getTime())) redirect(`${page}?error=${encodeURIComponent("That time isn't available. Please pick another.")}`);
  let token: string;
  try {
    ({ token } = await createTypeBooking(db, {
      showroom,
      type,
      startsAt,
      createdBy: "customer",
      details: { name: str(formData, "name"), email: str(formData, "email"), phone: str(formData, "phone"), smsConsent: bool(formData, "sms_consent"), note: str(formData, "note") },
      answers: (field) => str(formData, field),
      country: str(formData, "country"),
    }));
  } catch (err) {
    const date = str(formData, "date");
    const time = str(formData, "time");
    const tzq = [validTimeZone(str(formData, "tz")) ? `tz=${encodeURIComponent(str(formData, "tz"))}` : "", countryCode(str(formData, "country")) ? `country=${countryCode(str(formData, "country"))}` : ""].filter(Boolean).join("&");
    back(err instanceof TypeBookingError && err.code === "DETAILS" && date && time ? `${page}?date=${date}&time=${time}&confirm=1${tzq ? `&${tzq}` : ""}` : `${page}${tzq ? `?${tzq}` : ""}`, err);
  }
  const tz = validTimeZone(str(formData, "tz"));
  redirect(`/book/m/${token}?ok=booked${tz ? `&tz=${encodeURIComponent(tz)}` : ""}`);
}

export async function rescheduleTypeAction(token: string, formData: FormData) {
  const view = await getBookingByToken(db, token);
  if (!view) redirect(`/book/m/${token}`);
  const startsAt = new Date(str(formData, "starts_at"));
  try {
    if (Number.isNaN(startsAt.getTime())) throw new TypeBookingError("INVALID_SLOT");
    await rescheduleTypeBooking(db, { bookingId: view.booking.id, startsAt, actor: "customer" });
  } catch (err) {
    const tz = validTimeZone(str(formData, "tz"));
    back(`/book/m/${token}/reschedule${tz ? `?tz=${encodeURIComponent(tz)}` : ""}`, err);
  }
  const tz = validTimeZone(str(formData, "tz"));
  redirect(`/book/m/${token}?ok=rescheduled${tz ? `&tz=${encodeURIComponent(tz)}` : ""}`);
}

export async function cancelTypeAction(token: string) {
  const view = await getBookingByToken(db, token);
  if (!view) redirect(`/book/m/${token}`);
  try {
    await cancelTypeBooking(db, { bookingId: view.booking.id, actor: "customer", reason: "customer" });
  } catch (err) {
    back(`/book/m/${token}`, err);
  }
  redirect(`/book/m/${token}?ok=cancelled`);
}
