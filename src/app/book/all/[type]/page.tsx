import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { showrooms } from "@/db/schema";
import { BookingInfo } from "@/components/booking-calendar";
import { colorOf } from "@/lib/booking-types";
import { loadDirectory, openLine, orderStores, visitorPosition } from "@/lib/directory";
import { sp, type SearchParams } from "@/lib/flash";

export const metadata = { title: "Choose a showroom" };

/**
 * The all-showrooms directory: the screen before a store's booking card. Every store with this booking type
 * switched into the directory, closest to the visitor first. Tapping one opens that store's own booking page;
 * ?store=<slug> skips straight there (for a store's own page or an ad).
 */
export default async function DirectoryPage({ params, searchParams }: { params: Promise<{ type: string }>; searchParams: Promise<SearchParams> }) {
  const { type: typeSlug } = await params;
  const q = await searchParams;
  const dir = await loadDirectory(db, typeSlug);
  if (!dir) notFound();

  // Name, email, phone and country passed in by the website embed go on to the store's form.
  const carry = new URLSearchParams();
  for (const k of ["name", "email", "phone", "country"] as const) {
    const v = sp(q[k])?.slice(0, k === "phone" ? 40 : 200);
    if (v) carry.set(k, v);
  }
  carry.set("dir", "1");
  const storeHref = (slug: string) => `/book/${slug}/${dir.type.slug}?${carry.toString()}`;

  const pick = sp(q.store);
  if (pick && dir.stores.some((s) => s.slug === pick)) redirect(storeHref(pick));

  const { stores, closest } = orderStores(dir.stores, visitorPosition(await headers()));
  const [online] = await db.select({ slug: showrooms.slug }).from(showrooms).where(eq(showrooms.kind, "online")).limit(1);
  const accent = colorOf(dir.type.color).hex;
  const now = new Date();

  return (
    <div className="@container overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="grid @3xl:min-h-[540px] @3xl:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
        <div className="border-b border-border p-6 @3xl:border-b-0 @3xl:border-r">
          <BookingInfo
            brand="Biktrix showrooms"
            title={dir.type.name}
            durationMin={dir.type.durationMin}
            location={stores.length === 1 ? stores[0].city : `${stores.length} showrooms`}
            description={dir.type.description}
          />
        </div>
        <div className="p-6">
          <h2 className="text-lg font-semibold">Choose a showroom</h2>
          <ul className="mt-4 grid gap-3 @xl:grid-cols-2">
            {stores.map((s) => {
              const line = openLine(s.hours, s.timezone, now);
              const near = s.slug === closest;
              return (
                <li key={s.slug}>
                  <Link
                    href={storeHref(s.slug)}
                    className={`relative flex min-h-[88px] flex-col gap-0.5 rounded-xl border bg-card py-3 pl-4 pr-10 hover:border-foreground ${near ? "border-2" : "border-border"}`}
                    style={near ? { borderColor: accent } : undefined}
                  >
                    <span className="text-base font-bold">
                      {s.city}
                      {near && <span className="ml-2 rounded-full px-2 py-0.5 align-[2px] text-xs font-bold" style={{ background: `${accent}1f`, color: accent }}>Closest to you</span>}
                    </span>
                    {s.addressLine && <span className="text-sm text-muted">{s.addressLine.split(",")[0]}</span>}
                    {line && <span className={`text-sm font-medium ${line.open ? "text-green-700" : "text-muted"}`}>{line.text}</span>}
                    <span aria-hidden="true" className="absolute right-4 top-1/2 -translate-y-1/2 text-xl" style={{ color: accent }}>›</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {online && (
            <p className="mt-5 text-sm">
              Not near one? <Link href={`/book/${online.slug}`} className="font-medium underline" style={{ color: accent }}>Book a call with an eBike expert</Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
