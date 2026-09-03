"use server";

import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { BookingError, bookSlot, cancelBooking, rescheduleBooking } from "@/lib/booking";
import { bool, str } from "@/lib/flash";
import { getUnitByToken } from "@/lib/queries";
import { getShowroom } from "@/lib/showroom";
import { detachUnit, UnitError } from "@/lib/units";

async function load(token: string) {
  const showroom = await getShowroom(db);
  const view = await getUnitByToken(db, token);
  if (!view) redirect(`/b/${token}`);
  return { showroom, view };
}

export async function bookAction(token: string, formData: FormData) {
  const { showroom, view } = await load(token);
  const startsAt = new Date(str(formData, "starts_at"));
  const reschedule = bool(formData, "reschedule");
  const smsConsent = bool(formData, "sms_consent");
  const back = `/b/${token}/book?${reschedule ? "reschedule=1&" : ""}`;
  if (Number.isNaN(startsAt.getTime())) redirect(`${back}error=INVALID_SLOT`);
  let code: string | null = null;
  let late = false;
  try {
    if (reschedule) {
      const res = await rescheduleBooking(db, { showroom, unitId: view.unit.id, startsAt, actor: "customer", smsConsent });
      late = res.lateChange;
    } else {
      await bookSlot(db, { showroom, unitId: view.unit.id, startsAt, createdBy: "customer", smsConsent });
    }
  } catch (err) {
    if (err instanceof BookingError) code = err.code;
    else throw err;
  }
  if (code) redirect(`${back}error=${code}`);
  redirect(`/b/${token}?ok=${reschedule ? (late ? "rescheduled_late" : "rescheduled") : "booked"}`);
}

export async function cancelAction(token: string) {
  const { showroom, view } = await load(token);
  let code: string | null = null;
  let late = false;
  try {
    const res = await cancelBooking(db, { showroom, unitId: view.unit.id, reason: "customer", actor: "customer" });
    late = res.lateChange;
  } catch (err) {
    if (err instanceof BookingError) code = err.code;
    else throw err;
  }
  if (code) redirect(`/b/${token}/manage?error=${code}`);
  redirect(`/b/${token}?ok=${late ? "cancelled_late" : "cancelled"}`);
}

export async function deferAction(token: string) {
  const { showroom, view } = await load(token);
  let error: string | null = null;
  try {
    await detachUnit(db, { showroom, unitId: view.unit.id, reason: "customer_deferred", actor: "customer" });
  } catch (err) {
    if (err instanceof UnitError || err instanceof BookingError) error = err.message;
    else throw err;
  }
  if (error) redirect(`/b/${token}/manage?error=${encodeURIComponent(error)}`);
  redirect(`/b/${token}?ok=deferred`);
}
