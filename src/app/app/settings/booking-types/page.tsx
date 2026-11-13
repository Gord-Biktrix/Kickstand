import Link from "next/link";
import { db } from "@/db/client";
import type { BookingType } from "@/db/schema";
import { Badge, Card, Field, Flash, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import {
  ACCESS_LABEL,
  CAPACITY_LABEL,
  formatDayHours,
  hoursSummary,
  listBookingTypes,
  LOCATION_LABEL,
  NEW_TYPE_DEFAULTS,
  presetsFor,
  WEEKDAY_8_TO_4,
  WEEKDAYS,
  type BookingLocation,
  type WeeklyHours,
} from "@/lib/booking-types";
import { baseUrl } from "@/lib/messages";
import { addPresetBookingTypeAction, createBookingTypeAction, setBookingTypeActiveAction, updateBookingTypeAction } from "../../actions";

export const metadata = { title: "Booking types" };

/**
 * What customers can book with this profile, like Calendly's event types. Each store and the online team
 * have their own list. The bike pickup is listed too, but its times come from Settings › Capacity.
 */
export default async function BookingTypesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const user = await requireUser("manager");
  const showroom = await currentShowroom(user);
  const types = await listBookingTypes(db, showroom.id);
  const online = showroom.kind === "online";
  const existing = new Set(types.map((t) => t.name));
  const presets = presetsFor(showroom.kind).filter((p) => !existing.has(p.name));

  return (
    <div>
      <PageHeader
        title={`Booking types · ${showroom.name}`}
        subtitle={online
          ? "What customers can book with the online team. Calls only: there's no address. Each type has its own length, hours and notice."
          : "What customers can book at this store. Each type has its own length, hours and notice. Other stores and the online team keep their own lists."}
      />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <p className="mb-4 text-sm">
        Public booking page: <a href={`/book/${showroom.slug}`} target="_blank" rel="noreferrer" className="font-medium underline">{baseUrl()}/book/{showroom.slug}</a>
        <span className="text-muted"> · lists every public type that&apos;s switched on. Each type also has its own link, shown on its card.</span>
      </p>
      <details className="mb-4 rounded-lg border border-border bg-card p-3 text-sm">
        <summary className="cursor-pointer font-medium">Put it on the website</summary>
        <p className="mt-2 text-muted">Paste this where the booking box should appear (Shopify: a Custom Liquid or HTML block). It grows to fit, and replaces the old YouCanBookMe box.</p>
        <pre className="mt-2 overflow-x-auto rounded bg-background p-2 text-xs"><code>{`<div data-biktrix-booking="${showroom.slug}"></div>\n<script src="${baseUrl()}/embed.js" async></script>`}</code></pre>
        <p className="mt-2 text-muted">To show one type only, add its id: <code className="text-xs">data-type=&quot;{types.find((t) => t.kind === "standard")?.slug ?? "test-ride"}&quot;</code>. Ids are the last part of each type&apos;s link.</p>
      </details>
      <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card title="Add a booking type">
            {presets.length > 0 && (
              <form action={addPresetBookingTypeAction} className="mb-5 space-y-2">
                <p className="text-sm text-muted">Start from a common one:</p>
                <div className="flex flex-wrap gap-2">
                  {presets.map((p) => (
                    <button key={p.key} type="submit" name="preset" value={p.key} className="btn btn-sm">+ {p.name}</button>
                  ))}
                </div>
              </form>
            )}
            <details>
              <summary className="cursor-pointer text-sm font-medium">Start from scratch</summary>
              <form action={createBookingTypeAction} className="mt-3 space-y-3">
                <TypeFields idp="new" online={online} />
                <button type="submit" className="btn btn-primary">Add booking type</button>
              </form>
            </details>
          </Card>
          <p className="text-xs text-muted">
            New types start at {NEW_TYPE_DEFAULTS.durationMin} minutes on a {NEW_TYPE_DEFAULTS.slotStepMin}-minute grid, {NEW_TYPE_DEFAULTS.noticeMin / 60} hours&apos; notice, up to {NEW_TYPE_DEFAULTS.horizonDays} days ahead, Mon–Fri 8:00–16:00. Change any of it per type.
          </p>
        </div>

        <div className="min-w-0 space-y-4">
          {types.length === 0 && <Card><p className="text-sm text-muted">No booking types yet. Add one on the left.</p></Card>}
          {types.map((t) => (
            <TypeCard key={t.id} t={t} online={online} profileSlug={showroom.slug} />
          ))}
        </div>
      </div>
    </div>
  );
}

function TypeCard({ t, online, profileSlug }: { t: BookingType; online: boolean; profileSlug: string }) {
  const pickup = t.kind === "pickup";
  return (
    <Card
      title={<span className={t.active ? undefined : "text-muted"}>{t.name}</span>}
      action={
        <div className="flex flex-wrap items-center gap-2">
          {!t.active && <Badge>off</Badge>}
          <Badge tone={t.access === "invite" ? "warn" : "ok"}>{t.access === "invite" ? "invite only" : "public"}</Badge>
          {!pickup && (
            <form action={setBookingTypeActiveAction.bind(null, t.id, !t.active)}>
              <button type="submit" className="btn btn-sm">{t.active ? "Switch off" : "Switch on"}</button>
            </form>
          )}
        </div>
      }
    >
      {t.description && <p className="mb-2 text-sm">{t.description}</p>}
      {pickup ? (
        <p className="text-sm text-muted">
          Customers book this from the link sent when their bike arrives. Times and how many fit per day: <Link href="/app/settings/capacity" className="underline">Settings › Capacity</Link>.
        </p>
      ) : (
        <p className="text-sm text-muted">
          {t.access === "public" && t.active && <><a href={`/book/${profileSlug}/${t.slug}`} target="_blank" rel="noreferrer" className="underline">/book/{profileSlug}/{t.slug}</a> · </>}
          {LOCATION_LABEL[t.location as BookingLocation]} · {t.durationMin} min{t.bufferMin ? ` + ${t.bufferMin} min buffer` : ""} · {hoursSummary(t.hours as WeeklyHours)} · {t.capacityMode === "bench" ? `${t.benchCapacity} at a time` : "one per staff member"} · {t.noticeMin >= 60 ? `${+(t.noticeMin / 60).toFixed(1)} h` : `${t.noticeMin} min`} notice · up to {t.horizonDays} days ahead{t.createsWorkOrder ? " · creates a Lightspeed work order" : ""}
        </p>
      )}
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium">Edit</summary>
        <form action={updateBookingTypeAction.bind(null, t.id)} className="mt-3 space-y-3">
          <input type="hidden" name="kind" value={t.kind} />
          {pickup ? (
            <>
              <Field label="Name" htmlFor={`name_${t.id}`}><input id={`name_${t.id}`} name="name" defaultValue={t.name} required className="input" /></Field>
              <Field label="Description" htmlFor={`desc_${t.id}`}><textarea id={`desc_${t.id}`} name="description" defaultValue={t.description} rows={2} className="input" /></Field>
            </>
          ) : (
            <TypeFields idp={t.id} online={online} t={t} />
          )}
          <button type="submit" className="btn btn-primary btn-sm">Save</button>
        </form>
      </details>
    </Card>
  );
}

function TypeFields({ idp, online, t }: { idp: string; online: boolean; t?: BookingType }) {
  const hours = (t?.hours as WeeklyHours | undefined) ?? WEEKDAY_8_TO_4;
  const locations: BookingLocation[] = online ? ["video", "phone"] : ["in_person", "video", "phone"];
  const id = (k: string) => `${k}_${idp}`;
  return (
    <>
      <Field label="Name" htmlFor={id("name")}><input id={id("name")} name="name" defaultValue={t?.name} required className="input" placeholder={online ? "Video call with an expert" : "Test ride"} /></Field>
      <Field label="Description" htmlFor={id("desc")} hint="Shown to customers on the booking page."><textarea id={id("desc")} name="description" defaultValue={t?.description} rows={2} className="input" /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Where" htmlFor={id("loc")}>
          <select id={id("loc")} name="location" defaultValue={t?.location ?? locations[0]} className="input">
            {locations.map((l) => <option key={l} value={l}>{LOCATION_LABEL[l]}</option>)}
          </select>
        </Field>
        <Field label="Who can book" htmlFor={id("access")}>
          <select id={id("access")} name="access" defaultValue={t?.access ?? "public"} className="input">
            {(["public", "invite"] as const).map((a) => <option key={a} value={a}>{ACCESS_LABEL[a]}</option>)}
          </select>
        </Field>
        <Field label="Length (minutes)" htmlFor={id("dur")}><input id={id("dur")} name="duration_min" type="number" min={5} max={480} required defaultValue={t?.durationMin ?? NEW_TYPE_DEFAULTS.durationMin} className="input" /></Field>
        <Field label="Buffer after (minutes)" htmlFor={id("buf")}><input id={id("buf")} name="buffer_min" type="number" min={0} max={240} defaultValue={t?.bufferMin ?? NEW_TYPE_DEFAULTS.bufferMin} className="input" /></Field>
        <Field label="Start times every (minutes)" htmlFor={id("step")}><input id={id("step")} name="slot_step_min" type="number" min={5} max={240} required defaultValue={t?.slotStepMin ?? NEW_TYPE_DEFAULTS.slotStepMin} className="input" /></Field>
        <Field label="Minimum notice (hours)" htmlFor={id("notice")}><input id={id("notice")} name="notice_hours" type="number" min={0} step={0.5} required defaultValue={(t?.noticeMin ?? NEW_TYPE_DEFAULTS.noticeMin) / 60} className="input" /></Field>
        <Field label="Bookable up to (days ahead)" htmlFor={id("horizon")}><input id={id("horizon")} name="horizon_days" type="number" min={1} max={365} required defaultValue={t?.horizonDays ?? NEW_TYPE_DEFAULTS.horizonDays} className="input" /></Field>
        <Field label="Capacity" htmlFor={id("cap")} hint="Bench is the default: a fixed number of bookings at once for the store.">
          <select id={id("cap")} name="capacity_mode" defaultValue={t?.capacityMode ?? "bench"} className="input">
            {(["bench", "staff"] as const).map((c) => <option key={c} value={c}>{CAPACITY_LABEL[c]}</option>)}
          </select>
        </Field>
        <Field label="Bookings at the same time (bench)" htmlFor={id("bench")}><input id={id("bench")} name="bench_capacity" type="number" min={1} max={50} defaultValue={t?.benchCapacity ?? NEW_TYPE_DEFAULTS.benchCapacity} className="input" /></Field>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Hours it can be booked</legend>
        <p className="text-xs text-muted">Like 8:00-16:00, or 9am-12pm, 1pm-5pm. Leave a day blank when it can&apos;t be booked.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {WEEKDAYS.map((d, wd) => (
            <label key={d} className="flex items-center gap-2 text-sm">
              <span className="w-9 shrink-0 text-muted">{d}</span>
              <input name={`hours_${wd}`} defaultValue={formatDayHours(hours[String(wd)])} className="input h-8 py-0 text-sm" aria-label={`${d} hours`} />
            </label>
          ))}
        </div>
      </fieldset>
      {!online && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="creates_work_order" defaultChecked={t?.createsWorkOrder ?? false} className="h-4 w-4" />
          Create a Lightspeed work order when booked (service appointments)
        </label>
      )}
    </>
  );
}
