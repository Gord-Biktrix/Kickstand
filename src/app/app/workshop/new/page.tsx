import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "@/db/client";
import { lsEmployees } from "@/db/schema";
import { zoneLabel } from "@/app/book/zone";
import { BookingCalendar, BookingInfo } from "@/components/booking-calendar";
import { QuestionFields } from "@/components/question-fields";
import { TicketPos } from "@/components/ticket-pos";
import { Flash } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { readQuestions } from "@/lib/booking-questions";
import { colorOf, ensureDefaultBookingTypes, ensureStoreHours, listBookingTypes, LOCATION_LABEL, type BookingLocation } from "@/lib/booking-types";
import { benchLoads, estimateReady } from "@/lib/ready-estimate";
import { workshopJobs } from "@/lib/workshop";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { lightspeedEnabled } from "@/lib/lightspeed";
import { formatLongDateFromLocal, formatTime } from "@/lib/time";
import { getTypeAvailability } from "@/lib/type-slots";
import { SERVICE_MENU } from "@/lib/tickets";
import type { ShowroomCtx } from "@/lib/showroom";
import type { BookingType } from "@/db/schema";
import { createTicketAction, staffCreateTypeBookingAction } from "../../actions";

export const metadata = { title: "New ticket" };

/** The ticket fields that ride along in the URL while the Schedule popup is open (and after an error). */
const KEEP = ["c", "nn", "np", "ne", "bike", "serial", "sid", "service", "labour", "part", "said", "mech"] as const;
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

  const services = all(q.service);
  const labour = all(q.labour);
  const partLines = all(q.part);
  const work = services.reduce((s, n) => s + (SERVICE_MENU.find((x) => x.name === n)?.minutes ?? 0), 0) + labour.reduce((s, m) => s + (Number(m) || 0), 0);
  // Ready-by: the queue on the benches plus this job's work, in the store's open hours (lib/ready-estimate.ts).
  const now = new Date();
  const [hours, jobs] = await Promise.all([ensureStoreHours(db, showroom), workshopJobs(db, showroom, now)]);
  const benches = showroom.settings.workshop_benches;
  const loads = benchLoads(jobs, benches, now);
  const ready = v("ready") || (work ? formatInTimeZone(estimateReady({ now, work, loads, hours, tz }), tz, "yyyy-MM-dd'T'HH:mm") : "");

  // After an error or while scheduling, the picked customer comes back in `c`.
  const picked = v("c");
  const [pLs, pName, pPhone, pEmail] = picked && picked !== "new" ? picked.split("|") : [];
  const initialPick = picked && picked !== "new" && pName ? { value: picked, name: pName, sub: [pPhone, pEmail].filter(Boolean).join(" · ") || (pLs ? "Lightspeed customer" : "") } : null;

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
          services={SERVICE_MENU}
          employees={employees}
          tz={tz}
          enabled={ls}
          canSchedule={!!serviceType}
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
  const questions = readQuestions(type.questions);
  const known: Record<string, string> = { bike: props.bike, serial: props.serial };
  const others = questions.filter((qq) => !(qq.id in known));

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
          <div className="mx-auto max-w-2xl rounded-xl border border-border bg-card p-5">
            <p className="text-lg font-bold">{formatLongDateFromLocal(date!)} · {formatTime(slot.startsAt, tz)} – {formatTime(slot.endsAt, tz)}</p>
            <form action={staffCreateTypeBookingAction.bind(null, type.id)} className="mt-3 space-y-3">
              <input type="hidden" name="starts_at" value={slot.startsAt.toISOString()} />
              <input type="hidden" name="date" value={date} />
              <input type="hidden" name="time" value={time} />
              <input type="hidden" name="back" value={`${base}&date=${date}`} />
              <input type="hidden" name="ls_customer_id" value={customer.ls} />
              <input type="hidden" name="ls_serialized_id" value={props.sid} />
              {questions.filter((qq) => qq.id in known).map((qq) => <input key={qq.id} type="hidden" name={`q_${qq.id}`} value={known[qq.id]} />)}
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="grid gap-1 text-sm"><span className="font-semibold">Name</span><input name="name" required defaultValue={customer.name} className="input" /></label>
                <label className="grid gap-1 text-sm"><span className="font-semibold">Phone</span><input name="phone" type="tel" defaultValue={customer.phone} className="input" /></label>
                <label className="grid gap-1 text-sm"><span className="font-semibold">Email</span><input name="email" type="email" defaultValue={customer.email} className="input" /></label>
              </div>
              {props.bike && <p className="text-sm">Bike: <strong>{props.bike}</strong>{props.serial ? ` · serial ${props.serial}` : ""}</p>}
              <QuestionFields questions={others} idPrefix="sch" />
              <label className="grid gap-1 text-sm"><span className="font-semibold">Note</span><textarea name="note" rows={2} defaultValue={props.note} className="input" /></label>
              <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="sms_consent" className="h-5 w-5" /> Customer agrees to text messages about this booking</label>
              <div className="flex flex-wrap gap-2">
                <button type="submit" className="btn btn-primary min-h-12 px-6">Book it</button>
                <Link href={`${base}&date=${date}`} className="btn min-h-12">Pick another time</Link>
              </div>
              <p className="text-xs text-muted">Creates the booking and its Lightspeed work order (Appointment); the customer gets the usual confirmation.</p>
            </form>
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
