import Link from "next/link";
import { db } from "@/db/client";
import { lsEmployees } from "@/db/schema";
import { TicketPos } from "@/components/ticket-pos";
import { Flash } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { ensureDefaultBookingTypes, ensureStoreHours, listBookingTypes } from "@/lib/booking-types";
import { benchLoads, estimateReady } from "@/lib/ready-estimate";
import { workshopJobs } from "@/lib/workshop";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { lightspeedEnabled } from "@/lib/lightspeed";
import { formatInZone, formatShortDateFromLocal, formatTime } from "@/lib/time";
import { getTypeAvailability } from "@/lib/type-slots";
import { SERVICE_MENU } from "@/lib/tickets";
import { loadServiceItems, pickTiles } from "@/lib/service-items";
import { listShowrooms } from "@/lib/showroom";
import { LightspeedClient } from "@/lib/lightspeed";
import { lightspeedReason } from "@/lib/workorder-lines";
import { createTicketAction } from "../../actions";

export const metadata = { title: "New ticket" };

const dropLabel = (d: Date, tz: string) => formatInZone(d, tz, "EEE d MMM, h:mm a").replace("AM", "am").replace("PM", "pm");
const all = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

/**
 * New ticket, POS style (components/ticket-pos.tsx): check the bike in now, or schedule the service for the
 * earliest open slot or a day and time from the calendar on the ticket. Booking creates the service appointment
 * (store's service type) and its Lightspeed work order with the ticket's lines.
 */
export default async function NewTicketPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const user = await requireUser("staff");
  const showroom = await currentShowroom(user);
  const tz = showroom.timezone;
  const v = (k: string) => sp(q[k]) ?? "";
  const ls = lightspeedEnabled(showroom);
  const employees = await db.select({ id: lsEmployees.id, name: lsEmployees.name }).from(lsEmployees).orderBy(lsEmployees.name);
  await ensureDefaultBookingTypes(db, showroom);
  const serviceType = (await listBookingTypes(db, showroom.id)).find((t) => t.kind === "standard" && t.active && t.createsWorkOrder && t.location === "in_person") ?? null;

  // Service and labour tiles: the shop's Lightspeed items, or the starter list if Lightspeed can't be read.
  let tiles: { key: string; name: string; minutes: number; itemId?: string; price?: number | null; labour?: boolean }[] = SERVICE_MENU;
  let tilesNote = "Lightspeed isn't linked for this store, so these are Kickstand's starter services.";
  if (ls) {
    try {
      const others = (await listShowrooms(db)).filter((x) => x.id !== showroom.id).map((x) => `${x.name} ${x.slug}`);
      const items = pickTiles(await loadServiceItems(new LightspeedClient(db)), { selected: showroom.settings.workshop_service_items, store: `${showroom.name} ${showroom.slug}`, otherStores: others });
      if (items.length) {
        tiles = items.map((i) => ({ key: i.itemId, name: i.name, minutes: i.minutes ?? showroom.settings.repair_minutes, itemId: i.itemId, price: i.price, labour: i.labour }));
        tilesNote = "";
      } else tilesNote = "None of your Lightspeed items look like workshop services, so these are Kickstand's starter services. Pick yours in Settings › Services.";
    } catch (err) {
      tilesNote = `Lightspeed didn't send its service items (${lightspeedReason(err)}), so these are Kickstand's starter services.`;
    }
  }
  const services = all(q.service);
  const labour = all(q.labour);
  const partLines = all(q.part);
  const work = services.reduce((s, n) => s + (tiles.find((x) => x.name === n)?.minutes ?? 0), 0) + labour.reduce((s, m) => s + (Number(m) || 0), 0);
  // Ready-by: the queue on the benches plus this job's work, in the store's open hours (lib/ready-estimate.ts).
  const now = new Date();
  const [hours, jobs] = await Promise.all([ensureStoreHours(db, showroom), workshopJobs(db, showroom, now)]);
  const benches = showroom.settings.workshop_benches;
  const loads = benchLoads(jobs, benches, now);
  const ready = v("ready") || (work ? formatInZone(estimateReady({ now, work, loads, hours, tz }), tz, "yyyy-MM-dd'T'HH:mm") : "");

  // After an error or while scheduling, the picked customer comes back in `c`.
  const picked = v("c");
  const [pLs, pName, pPhone, pEmail] = picked && picked !== "new" ? picked.split("|") : [];
  const initialPick = picked && picked !== "new" && pName ? { value: picked, name: pName, sub: [pPhone, pEmail].filter(Boolean).join(" · ") || (pLs ? "Lightspeed customer" : "") } : null;

  // Schedule service: now (walk-in), the earliest open service slot, or a day and time from the calendar.
  const serviceDays = serviceType ? await getTypeAvailability(db, { showroom, type: serviceType }) : [];
  const days = serviceDays
    .map((d) => ({ date: d.date, label: formatShortDateFromLocal(d.date), slots: d.slots.filter((sl) => sl.startsAt > now).map((sl) => ({ iso: sl.startsAt.toISOString(), time: formatTime(sl.startsAt, tz), label: dropLabel(sl.startsAt, tz) })) }))
    .filter((d) => d.slots.length);
  // After an error the chosen time comes back in ?dropoff=.
  const initialDropoff = days.flatMap((d) => d.slots).some((sl) => sl.iso === v("dropoff")) ? v("dropoff") : "now";

  return (
    <div>
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Link href="/app/workshop" className="text-sm underline">← Workshop</Link>
        {!ls && <p className="text-sm text-red-700">Lightspeed isn&apos;t switched on for this store, so tickets can&apos;t be created here.</p>}
      </div>

      <form action={createTicketAction} className="grid gap-4 lg:grid-cols-[420px_minmax(0,1fr)]">
        <TicketPos
          services={tiles.filter((t) => !t.labour)}
          labourItems={tiles.filter((t) => t.labour)}
          tilesNote={tilesNote}
          employees={employees}
          tz={tz}
          enabled={ls}
          days={days}
          initialDropoff={initialDropoff}
          defaultMinutes={showroom.settings.repair_minutes}
          benches={benches}
          loads={loads}
          hours={hours}
          initial={{ pick: initialPick, newCustomer: { nn: v("nn"), np: v("np"), ne: v("ne") }, bike: v("bike"), serial: v("serial"), sid: v("sid"), services, labour, parts: partLines, said: v("said"), ready, mech: v("mech") }}
        />
      </form>

    </div>
  );
}

