import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { Card } from "@/components/ui";
import { colorOf, ensureDefaultBookingTypes, listBookingTypes, LOCATION_LABEL, type BookingLocation } from "@/lib/booking-types";
import { getShowroom } from "@/lib/showroom";

export async function generateMetadata({ params }: { params: Promise<{ profile: string }> }) {
  const showroom = await getShowroom(db, (await params).profile).catch(() => null);
  return { title: showroom ? `Book with ${showroom.name}` : "Book an appointment" };
}

/** A profile's public booking page, Calendly-style: one card per public, switched-on type. Bike pickup is invite-only, so never listed. */
export default async function ProfileBookingPage({ params }: { params: Promise<{ profile: string }> }) {
  const { profile } = await params;
  const showroom = await getShowroom(db, profile).catch(() => null);
  if (!showroom) notFound();
  await ensureDefaultBookingTypes(db, showroom);
  const types = (await listBookingTypes(db, showroom.id)).filter((t) => t.kind === "standard" && t.access === "public" && t.active);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="text-center">
        <p className="text-sm font-semibold uppercase tracking-widest text-accent">Biktrix</p>
        <h1 className="mt-1 text-2xl font-bold">{showroom.name}</h1>
        {showroom.kind === "showroom" && showroom.addressLine && <p className="mt-1 text-sm text-muted">{showroom.addressLine}</p>}
        <p className="mt-3 text-sm text-muted">Pick what you&apos;d like to book.</p>
      </div>
      {types.length === 0 ? (
        <Card><p className="text-sm">Online booking isn&apos;t open here yet.{showroom.phone ? ` Call us at ${showroom.phone}.` : ""}</p></Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {types.map((t) => (
            <li key={t.id}>
              <Link href={`/book/${showroom.slug}/${t.slug}`} className="block h-full rounded-xl border border-border bg-card p-5 shadow-sm hover:shadow-md focus-visible:outline-2 focus-visible:outline-accent" style={{ borderTop: `6px solid ${colorOf(t.color).hex}` }}>
                <div className="text-lg font-semibold">{t.name}</div>
                <div className="mt-1 text-sm text-muted">{t.durationMin} min · {LOCATION_LABEL[t.location as BookingLocation]}</div>
                {t.description && <p className="mt-2 text-sm">{t.description}</p>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
