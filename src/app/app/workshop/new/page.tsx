import Link from "next/link";
import { formatInZone } from "@/lib/time";
import { db } from "@/db/client";
import { lsEmployees } from "@/db/schema";
import { zoneLabel } from "@/app/book/zone";
import { BookingCalendar, BookingInfo } from "@/components/booking-calendar";
import { TicketPos } from "@/components/ticket-pos";
import { Flash } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { colorOf, ensureDefaultBookingTypes, ensureStoreHours, listBookingTypes, LOCATION_LABEL, type BookingLocation } from "@/lib/booking-types";
import { benchLoads, estimateReady } from "@/lib/ready-estimate";
import { workshopJobs } from "@/lib/workshop";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { lightspeedEnabled } from "@/lib/lightspeed";
import { formatLongDateFromLocal, formatTime } from "@/lib/time";
import { getTypeAvailability } from "@/lib/type-slots";
import { SERVICE_MENU } from "@/lib/tickets";
import { loadServiceItems, pickTiles } from "@/lib/service-items";
import { listShowrooms } from "@/lib/showroom";
import { LightspeedClient } from "@/lib/lightspeed";
import { lightspeedReason } from "@/lib/workorder-lines";
import type { ShowroomCtx } from "@/lib/showroom";
import type { BookingType } from "@/db/schema";
import { createTicketAction } from "../../actions";

export const metadata = { title: "New ticket" };

/** The ticket fields that ride along in the URL while the Schedule popup is open (and after an error). */
const KEEP = ["c", "nn", "np", "ne", "bike", "serial", "sid", "service", "labour", "part", "said", "mech"] as const;
const dropLabel = (d: Date, tz: string) => formatInZone(d, tz, "EEE d MMM, h:mm a").replace("AM", "am").replace("PM", "pm");
const all = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

/**
 * New ticket, POS style (components/ticket-pos.tsx): check the bike in now, or "Schedule for later", which opens
 * the booking calendar (the same one staff use to book for a customer) for the store's service type with the
 * customer, bike and notes carried over. Booking creates the service appointment and its Lightspeed work order.
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

  // Drop-off: now (walk-in), the earliest open service slot, or a time picked in the calendar (comes back as ?dropoff=).
  const serviceDays = serviceType ? await getTypeAvailability(db, { showroom, type: serviceType }) : [];
  const firstSlot = serviceDays.flatMap((d) => d.slots).find((sl) => sl.startsAt > now);
  const earliest = firstSlot ? { iso: firstSlot.startsAt.toISOString(), label: dropLabel(firstSlot.startsAt, tz) } : null;
  const pickedDrop = v("dropoff") && v("dropoff") !== "now" && !Number.isNaN(new Date(v("dropoff")).getTime()) ? { iso: new Date(v("dropoff")).toISOString(), label: dropLabel(new Date(v("dropoff")), tz) } : null;

  const keep = new URLSearchParams();
  for (const k of KEEP) for (const val of all(q[k])) keep.append(k, val);
  const ticketUrl = `/app/workshop/new${keep.size ? `?${keep.toString()}` : ""}`;

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
          canSchedule={!!serviceType}
          earliest={earliest}
          pickedDropoff={pickedDrop}
          defaultMinutes={showroom.settings.repair_minutes}
          benches={benches}
          loads={loads}
          hours={hours}
          initial={{ pick: initialPick, newCustomer: { nn: v("nn"), np: v("np"), ne: v("ne") }, bike: v("bike"), serial: v("serial"), sid: v("sid"), services, labour, parts: partLines, said: v("said"), ready, mech: v("mech") }}
        />
      </form>

      {v("schedule") === "1" && serviceType && (
        <SchedulePopup
          q={q}
          ticketUrl={ticketUrl}
          keep={keep}
          customer={initialPick ? { ls: pLs ?? "", name: pName ?? "", phone: pPhone ?? "", email: pEmail ?? "" } : { ls: "", name: v("nn"), phone: v("np"), email: v("ne") }}
          bike={v("bike")}
          serial={v("serial")}
          sid={v("sid")}
          note={[[...services, ...labour.map((m) => `labour ${m} min`), ...partLines.map((p) => p.split("|").slice(2).join("|") || "part")].join(" + "), v("said")].filter(Boolean).join(". ")}
          type={serviceType}
          showroom={showroom}
        />
      )}
    </div>
  );
}


/** The booking calendar as a popup over the ticket, then the booking details with everything carried over. */
async function SchedulePopup(props: {
  q: SearchParams;
  ticketUrl: string;
  keep: URLSearchParams;
  customer: { ls: string; name: string; phone: string; email: string };
  bike: string;
  serial: string;
  sid: string;
  note: string;
  type: BookingType;
  showroom: ShowroomCtx;
}) {
  const { q, type, showroom, customer } = props;
  const tz = showroom.timezone;
  const days = await getTypeAvailability(db, { showroom, type });
  const date = sp(q.date);
  const time = sp(q.time);
  const slot = date && time && sp(q.confirm) === "1" ? days.find((d) => d.date === date)?.slots.find((s) => s.time === time) : undefined;
  const base = `/app/workshop/new?${new URLSearchParams([...props.keep.entries(), ["schedule", "1"]]).toString()}`;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="sched-title" className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8">
      <div className="w-full max-w-6xl rounded-2xl bg-[#edebe7] p-4 shadow-2xl sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="sched-title" className="text-xl font-extrabold">Schedule {customer.name || "the customer"} · {type.name}</h2>
            <p className="text-sm text-muted">{[props.bike, props.note].filter(Boolean).join(" · ") || "Pick a time."}</p>
          </div>
          <Link href={props.ticketUrl} className="btn">Close</Link>
        </div>

        {slot ? (
          <div className="mx-auto max-w-md rounded-xl border border-border bg-card p-5 text-center">
            <p className="text-sm text-muted">Drop-off</p>
            <p className="text-lg font-bold">{formatLongDateFromLocal(date!)} · {formatTime(slot.startsAt, tz)}</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Link href={`${props.ticketUrl}${props.ticketUrl.includes("?") ? "&" : "?"}dropoff=${encodeURIComponent(slot.startsAt.toISOString())}`} className="btn btn-primary min-h-12 px-6">Use this time</Link>
              <Link href={`${base}&date=${date}`} className="btn min-h-12">Pick another time</Link>
            </div>
            <p className="mt-3 text-xs text-muted">Back on the ticket, &ldquo;Book drop-off&rdquo; books it and puts the lines on the work order.</p>
          </div>
        ) : (
          <BookingCalendar
            days={days}
            tz={tz}
            base={base}
            month={sp(q.month)}
            date={date}
            time={time}
            accent={colorOf(type.color).hex}
            zone={zoneLabel(tz)}
            info={<BookingInfo brand={showroom.name} title={type.name} durationMin={type.durationMin} location={LOCATION_LABEL[type.location as BookingLocation]} />}
          />
        )}
      </div>
    </div>
  );
}
