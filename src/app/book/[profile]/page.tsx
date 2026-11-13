import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { Card } from "@/components/ui";
import { listBookingTypes, LOCATION_LABEL, type BookingLocation } from "@/lib/booking-types";
import { getShowroom } from "@/lib/showroom";

export async function generateMetadata({ params }: { params: Promise<{ profile: string }> }) {
  const showroom = await getShowroom(db, (await params).profile).catch(() => null);
  return { title: showroom ? `Book with ${showroom.name}` : "Book an appointment" };
}

/** A profile's public booking page: every public, switched-on booking type. The bike pickup is invite-only, so never listed. */
export default async function ProfileBookingPage({ params }: { params: Promise<{ profile: string }> }) {
  const { profile } = await params;
  const showroom = await getShowroom(db, profile).catch(() => null);
  if (!showroom) notFound();
  const types = (await listBookingTypes(db, showroom.id)).filter((t) => t.kind === "standard" && t.access === "public" && t.active);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{showroom.name}</h1>
        {showroom.kind === "showroom" && showroom.addressLine && <p className="mt-1 text-sm text-muted">{showroom.addressLine}</p>}
      </div>
      {types.length === 0 ? (
        <Card><p className="text-sm">Online booking isn&apos;t open here yet.{showroom.phone ? ` Call us at ${showroom.phone}.` : ""}</p></Card>
      ) : (
        <ul className="space-y-3">
          {types.map((t) => (
            <li key={t.id}>
              <Link href={`/book/${showroom.slug}/${t.slug}`} className="block rounded-xl border border-border bg-card p-4 hover:border-accent focus-visible:outline-2 focus-visible:outline-accent">
                <div className="font-semibold">{t.name}</div>
                <div className="text-sm text-muted">{t.durationMin} min · {LOCATION_LABEL[t.location as BookingLocation]}</div>
                {t.description && <p className="mt-1 text-sm">{t.description}</p>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
