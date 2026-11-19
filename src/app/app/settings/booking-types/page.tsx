import Link from "next/link";
import { db } from "@/db/client";
import type { BookingType } from "@/db/schema";
import { CopyButton } from "@/components/copy-button";
import { HoursEditor } from "@/components/hours-editor";
import { QuestionsEditor } from "@/components/questions-editor";
import { readQuestions } from "@/lib/booking-questions";
import { Badge, Field, Flash, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import {
  ACCESS_LABEL,
  BOOKING_COLORS,
  CAPACITY_LABEL,
  colorOf,
  DURATION_CHOICES,
  effectiveHours,
  ensureDefaultBookingTypes,
  ensureStoreHours,
  hoursSummary,
  listBookingTypes,
  LOCATION_LABEL,
  NEW_TYPE_DEFAULTS,
  WEEKDAY_8_TO_4,
  type BookingLocation,
  type WeeklyHours,
} from "@/lib/booking-types";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { baseUrl } from "@/lib/messages";
import { EMBED_HOWS, type EmbedHow } from "@/lib/embed-script";
import { SharePanel } from "./share-panel";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { staffUsers } from "@/db/schema";
import { Avatar } from "@/components/avatar";
import { photoUrls } from "@/lib/staff-photos";
import { createBookingTypeAction, setBookingTypeActiveAction, updateBookingTypeAction } from "../../actions";

export const metadata = { title: "Booking types" };

/**
 * What customers can book with this profile, laid out like Calendly's event types: one compact row per type
 * (colour, name, length · where · who can book, Copy link, open, Turn on/off, Edit). New and Edit open a side
 * panel with the few fields that matter and "More options" for the rest, beside a live preview of the
 * customer's page. Store-wide hours live in Settings › Availability.
 */
export default async function BookingTypesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const user = await requireUser("manager");
  const showroom = await currentShowroom(user);
  await ensureDefaultBookingTypes(db, showroom);
  const storeHours = await ensureStoreHours(db, showroom);
  const types = await listBookingTypes(db, showroom.id);
  const online = showroom.kind === "online";
  const editing = sp(q.edit) ? types.find((t) => t.id === sp(q.edit)) : undefined;
  const creating = sp(q.new) === "1";
  const shareId = sp(q.share);
  const sharing = shareId === "all" ? null : shareId ? types.find((t) => t.id === shareId && t.kind === "standard") : undefined;
  const how = (EMBED_HOWS.some((h) => h.key === sp(q.how)) ? sp(q.how) : "inline") as EmbedHow;
  const root = baseUrl();
  const close = "/app/settings/booking-types";
  // Staff who can be shown on booking pages: everyone active in this profile (including all-stores people), with photos.
  const team = (editing || creating)
    ? await db.select({ id: staffUsers.id, name: staffUsers.name }).from(staffUsers).where(and(eq(staffUsers.active, true), or(eq(staffUsers.showroomId, showroom.id), isNull(staffUsers.showroomId), sql`${showroom.id} = any(${staffUsers.extraShowroomIds})`))).orderBy(staffUsers.name)
    : [];
  const teamPhotos = await photoUrls(db, team.map((p) => p.id));
  const people = team.map((p) => ({ ...p, photo: teamPhotos.get(p.id) ?? null }));

  return (
    <div>
      <PageHeader
        title={`Booking types · ${showroom.name}`}
        subtitle={online ? "What customers can book with the online team: video and phone calls." : "What customers can book at this store. Other stores and the online team keep their own lists."}
        action={
          <div className="flex flex-wrap gap-2">
            <Link href="/app/settings/availability" className="btn btn-sm">Manage availability</Link>
            <Link href={`${close}?new=1`} className="btn btn-primary btn-sm">+ New booking type</Link>
          </div>
        }
      />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Booking page:</span>
        <a href={`/book/${showroom.slug}`} target="_blank" rel="noreferrer" className="font-medium underline">{root}/book/{showroom.slug}</a>
        <CopyButton text={`${root}/book/${showroom.slug}`} />
        <Link href={`${close}?share=all`} className="btn btn-sm">Share / embed</Link>
      </div>

      <ul className="overflow-hidden rounded-xl border border-border bg-card">
        {types.map((t) => (
          <TypeRow key={t.id} t={t} profileSlug={showroom.slug} root={root} storeHours={storeHours} selected={editing?.id === t.id} />
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">Store availability: {hoursSummary(storeHours)} · <Link href="/app/settings/availability" className="underline">change</Link></p>

      {sharing !== undefined && (
        <SharePanel t={sharing} storeSlug={showroom.slug} storeName={showroom.name} root={root} close={close} how={how} text={sp(q.text)} color={sp(q.color)} textColor={sp(q.text_color)} scope={sp(q.scope)} />
      )}
      {(editing || creating) && (
        <EditorPanel t={editing} online={online} storeHours={storeHours} profileSlug={showroom.slug} close={close} people={people} />
      )}
    </div>
  );
}

function TypeRow({ t, profileSlug, root, storeHours, selected }: { t: BookingType; profileSlug: string; root: string; storeHours: WeeklyHours; selected: boolean }) {
  const pickup = t.kind === "pickup";
  const link = `${root}/book/${profileSlug}/${t.slug}`;
  const linkable = !pickup && t.access === "public";
  const meta = pickup
    ? "Invite only · times from Settings › Capacity"
    : `${t.durationMin} min · ${LOCATION_LABEL[t.location as BookingLocation]} · ${t.access === "invite" ? "Invite only" : "Public"} · ${t.useStoreHours ? "Store hours" : hoursSummary(effectiveHours(t, storeHours))}`;
  return (
    <li className={`flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 ${t.active ? "" : "bg-background opacity-70"} ${selected ? "ring-2 ring-inset ring-accent" : ""}`}>
      <span aria-hidden="true" className="h-10 w-1.5 shrink-0 rounded-full" style={{ background: colorOf(t.color).hex }} />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{t.name}{!t.active && <span className="ml-2"><Badge>off</Badge></span>}</p>
        <p className="truncate text-sm text-muted">{meta}{t.createsWorkOrder ? " · creates a Lightspeed work order" : ""}{t.inDirectory && t.access === "public" ? " · in the all-showrooms directory" : ""}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {linkable && t.active && <Link href={`/app/settings/booking-types?share=${t.id}`} className="btn btn-sm">Share</Link>}
        {linkable && t.active && <a href={link} target="_blank" rel="noreferrer" className="btn btn-sm" aria-label={`Open ${t.name} booking page`}>Open ↗</a>}
        {!pickup && (
          <form action={setBookingTypeActiveAction.bind(null, t.id, !t.active)}>
            <button type="submit" className="btn btn-sm">{t.active ? "Turn off" : "Turn on"}</button>
          </form>
        )}
        <Link href={`/app/settings/booking-types?edit=${t.id}`} className="btn btn-sm">Edit</Link>
      </div>
    </li>
  );
}

/** The Calendly-style side panel: name and colour, duration, location, availability; the rest under More options. */
function EditorPanel({ t, online, storeHours, profileSlug, close, people }: { t?: BookingType; online: boolean; storeHours: WeeklyHours; profileSlug: string; close: string; people: { id: string; name: string; photo: string | null }[] }) {
  const pickup = t?.kind === "pickup";
  const locations: BookingLocation[] = online ? ["video", "phone"] : ["in_person", "video", "phone"];
  const duration = t?.durationMin ?? NEW_TYPE_DEFAULTS.durationMin;
  const custom = !(DURATION_CHOICES as readonly number[]).includes(duration);
  const useStore = t ? t.useStoreHours : true;
  const preview = t && !pickup && t.active && t.access === "public" ? `/book/${profileSlug}/${t.slug}` : null;
  const action = t ? updateBookingTypeAction.bind(null, t.id) : createBookingTypeAction;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" role="dialog" aria-modal="true" aria-label={t ? `Edit ${t.name}` : "New booking type"}>
      <Link href={close} className="absolute inset-0" aria-label="Close" tabIndex={-1} />
      {preview && (
        <div className="relative hidden flex-1 p-6 xl:block">
          <div className="flex h-full flex-col overflow-hidden rounded-xl bg-card shadow-xl">
            <p className="border-b border-border bg-foreground px-4 py-2 text-xs text-white"><strong>Preview.</strong> What customers see. Save to update it.</p>
            <iframe src={preview} title="Preview of the booking page" className="w-full flex-1" />
          </div>
        </div>
      )}
      <form action={action} className="relative flex h-full w-full max-w-md flex-col bg-card shadow-2xl">
        <input type="hidden" name="kind" value={t?.kind ?? "standard"} />
        <div className="flex items-start justify-between border-b border-border p-5">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted">{t ? "Booking type" : "New booking type"}</p>
            <input name="name" defaultValue={t?.name ?? ""} required placeholder={online ? "Video call with an expert" : "Test ride"} aria-label="Name" className="mt-1 w-full rounded-md border border-transparent bg-transparent px-1 text-2xl font-bold hover:border-border focus:border-accent focus:outline-none" />
            {!pickup && (
              <div className="mt-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Colour">
                {Object.entries(BOOKING_COLORS).map(([key, c]) => (
                  <label key={key} className="cursor-pointer" title={c.label}>
                    <input type="radio" name="color" value={key} defaultChecked={(t?.color ?? "orange") === key} className="peer sr-only" />
                    <span className="block h-6 w-6 rounded-full ring-offset-2 peer-checked:ring-2 peer-focus-visible:ring-2" style={{ background: c.hex, ["--tw-ring-color" as string]: c.hex }} />
                    <span className="sr-only">{c.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <Link href={close} className="rounded p-1 text-2xl leading-none text-muted hover:text-foreground" aria-label="Close">×</Link>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          {pickup ? (
            <>
              <Field label="Description" htmlFor="pk_desc"><textarea id="pk_desc" name="description" defaultValue={t?.description} rows={3} className="input" /></Field>
              <p className="text-sm text-muted">Customers book the pickup from the link sent when their bike arrives. Its times and how many fit per day are set in <Link href="/app/settings/capacity" className="underline">Settings › Capacity</Link>.</p>
            </>
          ) : (
            <>
              <fieldset>
                <legend className="mb-2 font-semibold">Duration</legend>
                <div className="flex flex-wrap gap-2">
                  {DURATION_CHOICES.map((d) => (
                    <label key={d} className="cursor-pointer">
                      <input type="radio" name="duration" value={d} defaultChecked={!custom && duration === d} className="peer sr-only" />
                      <span className="block rounded-lg border border-border px-3 py-2 text-sm peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:font-semibold peer-focus-visible:ring-2">{d % 60 === 0 ? `${d / 60} hr` : `${d} min`}</span>
                    </label>
                  ))}
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-1 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                    <input type="radio" name="duration" value="custom" defaultChecked={custom} className="h-4 w-4" />
                    Custom
                    <input type="number" name="duration_custom" min={5} max={480} defaultValue={custom ? duration : ""} aria-label="Custom minutes" className="input h-8 w-20 py-0" /> min
                  </label>
                </div>
              </fieldset>

              <fieldset>
                <legend className="mb-2 font-semibold">Location</legend>
                <div className="grid grid-cols-3 gap-2">
                  {locations.map((l) => (
                    <label key={l} className="cursor-pointer">
                      <input type="radio" name="location" value={l} defaultChecked={(t?.location ?? locations[0]) === l} className="peer sr-only" />
                      <span className="flex h-20 flex-col items-center justify-center gap-1 rounded-lg border border-border text-sm peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:font-semibold peer-focus-visible:ring-2">
                        <LocationIcon l={l} />
                        {LOCATION_LABEL[l]}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend className="mb-2 font-semibold">Availability</legend>
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" name="hours_mode" value="store" defaultChecked={useStore} className="mt-1 h-4 w-4" />
                  <span>Store hours <span className="block text-xs text-muted">{hoursSummary(storeHours)} · <Link href="/app/settings/availability" className="underline">change</Link></span></span>
                </label>
                <label className="mt-2 flex items-start gap-2 text-sm">
                  <input type="radio" name="hours_mode" value="custom" defaultChecked={!useStore} className="mt-1 h-4 w-4" />
                  <span>Custom hours for this type</span>
                </label>
                <details className="mt-2" open={!useStore}>
                  <summary className="cursor-pointer text-xs text-muted">Set custom hours</summary>
                  <div className="mt-2"><HoursEditor hours={t && !t.useStoreHours ? (t.hours as WeeklyHours) : Object.keys(storeHours).length ? storeHours : WEEKDAY_8_TO_4} /></div>
                </details>
              </fieldset>

              <fieldset>
                <legend className="mb-1 font-semibold">Booking form</legend>
                <p className="mb-2 text-xs text-muted">Name, email, phone and a note are always asked. Add questions to know why they&apos;re booking; answers show in Slack, on the booking and in Klaviyo.</p>
                <QuestionsEditor initial={readQuestions(t?.questions)} />
              </fieldset>

              <fieldset>
                <legend className="mb-1 font-semibold">People on the booking page</legend>
                <p className="mb-2 text-xs text-muted">Customers see their photos above the title and on the list of appointment types, so they know who they&apos;ll talk to. Add photos in <Link href="/app/settings/staff" className="underline">Settings › Staff</Link>.</p>
                <input type="hidden" name="hosts_shown" value="1" />
                {people.length === 0 ? <p className="text-sm text-muted">No staff in this store yet.</p> : (
                  <ul className="space-y-1">
                    {people.map((p) => (
                      <li key={p.id}>
                        <label className="flex items-center gap-3 rounded-md px-1 py-1 text-sm hover:bg-background">
                          <input type="checkbox" name="host_ids" value={p.id} defaultChecked={t?.hostIds?.includes(p.id)} className="h-4 w-4" />
                          <Avatar name={p.name} photo={p.photo} size={28} />
                          <span>{p.name}{!p.photo && <span className="text-xs text-muted"> · no photo yet</span>}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </fieldset>

              {!online && <fieldset>
                <legend className="mb-1 font-semibold">All-showrooms directory</legend>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="in_directory" defaultChecked={t?.inDirectory ?? false} className="mt-0.5 h-4 w-4" />
                  <span>
                    List in the all-showrooms directory
                    <span className="block text-xs text-muted">Offered at every showroom{t ? ` · /book/all/${t.slug}` : ""}</span>
                  </span>
                </label>
              </fieldset>}

              <details className="rounded-lg border border-border p-3">
                <summary className="cursor-pointer font-semibold">More options</summary>
                <div className="mt-3 space-y-3">
                  <Field label="Description" htmlFor="ed_desc" hint="Shown to customers on the booking page."><textarea id="ed_desc" name="description" defaultValue={t?.description} rows={2} className="input" /></Field>
                  <Field label="Who can book" htmlFor="ed_access">
                    <select id="ed_access" name="access" defaultValue={t?.access ?? "public"} className="input">
                      {(["public", "invite"] as const).map((a) => <option key={a} value={a}>{ACCESS_LABEL[a]}</option>)}
                    </select>
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Buffer after (min)" htmlFor="ed_buf"><input id="ed_buf" name="buffer_min" type="number" min={0} max={240} defaultValue={t?.bufferMin ?? NEW_TYPE_DEFAULTS.bufferMin} className="input" /></Field>
                    <Field label="Start times every (min)" htmlFor="ed_step"><input id="ed_step" name="slot_step_min" type="number" min={5} max={240} defaultValue={t?.slotStepMin ?? NEW_TYPE_DEFAULTS.slotStepMin} className="input" /></Field>
                    <Field label="Minimum notice (hours)" htmlFor="ed_notice"><input id="ed_notice" name="notice_hours" type="number" min={0} step={0.5} defaultValue={(t?.noticeMin ?? NEW_TYPE_DEFAULTS.noticeMin) / 60} className="input" /></Field>
                    <Field label="Up to (days ahead)" htmlFor="ed_hz"><input id="ed_hz" name="horizon_days" type="number" min={1} max={365} defaultValue={t?.horizonDays ?? NEW_TYPE_DEFAULTS.horizonDays} className="input" /></Field>
                  </div>
                  <Field label="Capacity" htmlFor="ed_cap" hint="Bench: a set number of bookings at once for the store.">
                    <select id="ed_cap" name="capacity_mode" defaultValue={t?.capacityMode ?? "bench"} className="input">
                      {(["bench", "staff"] as const).map((c) => <option key={c} value={c}>{CAPACITY_LABEL[c]}</option>)}
                    </select>
                  </Field>
                  <Field label="Bookings at the same time (bench)" htmlFor="ed_bench"><input id="ed_bench" name="bench_capacity" type="number" min={1} max={50} defaultValue={t?.benchCapacity ?? NEW_TYPE_DEFAULTS.benchCapacity} className="input" /></Field>
                  {!online && (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="creates_work_order" defaultChecked={t?.createsWorkOrder ?? false} className="h-4 w-4" />
                      Create a Lightspeed work order when booked (in person only)
                    </label>
                  )}
                </div>
              </details>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          {preview && <a href={preview} target="_blank" rel="noreferrer" className="btn btn-sm xl:hidden">Preview ↗</a>}
          <Link href={close} className="btn">Cancel</Link>
          <button type="submit" className="btn btn-primary">{t ? "Save changes" : "Create"}</button>
        </div>
      </form>
    </div>
  );
}

function LocationIcon({ l }: { l: BookingLocation }) {
  const common = { "aria-hidden": true, width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8 } as const;
  if (l === "video") return <svg {...common}><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10l5-3v10l-5-3z" /></svg>;
  if (l === "phone") return <svg {...common}><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" /></svg>;
  return <svg {...common}><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></svg>;
}
