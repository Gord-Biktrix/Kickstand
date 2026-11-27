import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { Card } from "@/components/ui";
import { colorOf, datesLabel, ensureDefaultBookingTypes, listBookingTypes, LOCATION_LABEL, typeNotEnded, type BookingLocation } from "@/lib/booking-types";
import { toLocalDate } from "@/lib/time";
import { getShowroom } from "@/lib/showroom";
import { hostsFor } from "@/lib/staff-photos";
import { HostFaces } from "@/components/booking-calendar";

export async function generateMetadata({ params }: { params: Promise<{ profile: string }> }) {
  const showroom = await getShowroom(db, (await params).profile).catch(() => null);
  return { title: showroom ? `Book with ${showroom.name}` : "Book an appointment" };
}

/** A profile's public booking page, Calendly-style: one card per public, switched-on type. Bike pickup is invite-only, so never listed. */
export default async function ProfileBookingPage({ params, searchParams }: { params: Promise<{ profile: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Keep a share link's / embed's prefilled details (name, email, phone, country) when the customer picks a type.
  const sq = await searchParams;
  const keep = new URLSearchParams(["name", "email", "phone", "country"].flatMap((k) => (typeof sq[k] === "string" && sq[k] ? [[k, (sq[k] as string).slice(0, 200)]] : []))).toString();
  const { profile } = await params;
  const showroom = await getShowroom(db, profile).catch(() => null);
  if (!showroom) notFound();
  await ensureDefaultBookingTypes(db, showroom);
  const types = (await listBookingTypes(db, showroom.id)).filter((t) => t.kind === "standard" && t.access === "public" && t.active && typeNotEnded(t, toLocalDate(new Date(), showroom.timezone)));
  const hostsByType = new Map(await Promise.all(types.map(async (t) => [t.id, await hostsFor(db, t.hostIds)] as const)));
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
              <Link href={`/book/${showroom.slug}/${t.slug}${keep ? `?${keep}` : ""}`} className="block h-full rounded-xl border border-border bg-card p-5 shadow-sm hover:shadow-md focus-visible:outline-2 focus-visible:outline-accent" style={{ borderTop: `6px solid ${colorOf(t.color).hex}` }}>
                {(hostsByType.get(t.id)?.length ?? 0) > 0 && <div className="mb-3"><HostFaces hosts={hostsByType.get(t.id)!} size={40} /></div>}
                <div className="text-lg font-semibold">{t.name}</div>
                <div className="mt-1 text-sm text-muted">{datesLabel(t) ? `${datesLabel(t)} · ` : ""}{t.durationMin} min · {LOCATION_LABEL[t.location as BookingLocation]}</div>
                {t.description && <p className="mt-2 text-sm">{t.description}</p>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
