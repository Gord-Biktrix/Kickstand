import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { events } from "@/db/schema";
import { Timeline } from "@/components/timeline";
import { Alert, Card, Field, Flash, PageHeader } from "@/components/ui";
import { hasRole, requireUser } from "@/lib/auth";
import { sp, type SearchParams } from "@/lib/flash";
import { FLAG_KEYS, type ProgramSettings } from "@/lib/settings";
import { saveProgramSettingsAction } from "../../actions";
import { currentShowroom } from "@/lib/current-showroom";

export const metadata = { title: "Program settings" };

const NUMBER_FIELDS: { key: keyof ProgramSettings; label: string; hint?: string; step?: string }[] = [
  { key: "slot_minutes", label: "Slot length (minutes)" },
  { key: "min_lead_hours", label: "Minimum lead time (hours)", hint: "Earliest bookable slot is this far from now.", step: "0.5" },
  { key: "booking_horizon_days", label: "Booking horizon (days after invite)", hint: "Must be ≥ pick-up-by days." },
  { key: "book_by_days", label: "Book-by (days after invite)" },
  { key: "pickup_by_days", label: "Pick-up-by (days after invite)" },
  { key: "reschedule_cutoff_hours", label: "Free change cutoff (hours before slot)", step: "0.5" },
  { key: "extension_days", label: "Extension length (days)" },
  { key: "storage_rate_cents", label: "Storage rate (cents per day)" },
  { key: "storage_cap_cents", label: "Storage cap (cents)" },
  { key: "early_bird_hours", label: "Early-bird window (hours after invite)" },
  { key: "reminder_send_hour_local", label: "Day-before reminder hour (0–23 local)" },
  { key: "clock_run_hour_local", label: "Daily clock hour (0–23 local)" },
];

const FLAG_LABELS: Record<(typeof FLAG_KEYS)[number], string> = {
  storage_fee_enabled: "Storage fee (terms v2 orders only)",
  release_rule_enabled: "Release rule — re-tag unbooked units past book-by to the waitlist",
  defer_enabled: "Customer defer option",
  early_bird_enabled: "Early-bird reward tracking",
};

export default async function ProgramPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const user = await requireUser("manager");
  const admin = hasRole(user.role, "admin");
  const showroom = await currentShowroom();
  const s = showroom.settings;
  const log = await db
    .select()
    .from(events)
    .where(and(eq(events.showroomId, showroom.id), eq(events.type, "settings_changed"), sql`${events.payload}->>'area' <> 'capacity_override'`))
    .orderBy(desc(events.createdAt))
    .limit(30);

  return (
    <div>
      <PageHeader title="Program" subtitle={`${showroom.name} · ${showroom.timezone}`} />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <div className="grid gap-6 lg:grid-cols-3">
        <form action={saveProgramSettingsAction} className="space-y-6 lg:col-span-2">
          <Card title="Clock and booking">
            <div className="grid gap-3 sm:grid-cols-2">
              {NUMBER_FIELDS.map((f) => (
                <Field key={f.key} label={f.label} htmlFor={f.key} hint={f.hint}>
                  <input id={f.key} name={f.key} type="number" step={f.step ?? "1"} min={0} defaultValue={String(s[f.key] ?? "")} className="input" required />
                </Field>
              ))}
              <Field label="Early-bird reward text" htmlFor="early_bird_reward_text"><input id="early_bird_reward_text" name="early_bird_reward_text" defaultValue={s.early_bird_reward_text} className="input" /></Field>
              <Field label="Terms v2 effective date" htmlFor="terms_v2_effective_date" hint="Leave empty until the Appendix C paragraph is live at checkout. Orders on/after this date default to terms v2.">
                <input id="terms_v2_effective_date" name="terms_v2_effective_date" type="date" defaultValue={s.terms_v2_effective_date ?? ""} className="input" />
              </Field>
            </div>
          </Card>
          <Card title="Feature flags" action={!admin ? <span className="text-xs text-muted">admin only</span> : undefined}>
            {!admin && <div className="mb-3"><Alert tone="neutral">Flags are shown for reference; only an admin can change them.</Alert></div>}
            <ul className="space-y-2">
              {FLAG_KEYS.map((k) => (
                <li key={k}>
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" name={k} defaultChecked={s[k]} disabled={!admin} className="mt-1 h-4 w-4" /> {FLAG_LABELS[k]} <code className="ml-1 text-xs text-muted">{k}</code>
                  </label>
                </li>
              ))}
            </ul>
          </Card>
          <button type="submit" className="btn btn-primary">Save settings</button>
        </form>
        <Card title="Change log">
          <Timeline events={log} tz={showroom.timezone} />
          {log.length > 0 && (
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-muted">Show raw changes</summary>
              <pre className="mt-2 max-h-96 overflow-auto rounded bg-neutral-100 p-2">{JSON.stringify(log.map((e) => ({ at: e.createdAt, ...(e.payload as object) })), null, 1)}</pre>
            </details>
          )}
        </Card>
      </div>
    </div>
  );
}
