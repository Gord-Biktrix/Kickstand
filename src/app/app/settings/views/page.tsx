import { db } from "@/db/client";
import { ConfirmButton } from "@/components/confirm-button";
import { Card, Field, Flash, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { listViews, listWorkorderStatuses, unassignedStatuses } from "@/lib/workorders";
import { deleteViewAction, saveViewAction } from "../../actions";

export const metadata = { title: "Views" };

/** Manager-defined views over Lightspeed work orders: a name and the statuses it includes. */
export default async function ViewsSettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const user = await requireUser("manager");
  const showroom = await currentShowroom(user);
  const [views, statuses] = await Promise.all([listViews(db, showroom), listWorkorderStatuses(db)]);
  const editing = views.find((v) => v.id === sp(q.edit)) ?? null;
  const free = unassignedStatuses(statuses, views);

  // Plain render helper (not a component) so React doesn't see a new component type on every render.
  const statusPicker = (selected: number[], prefix: string) => (
    <fieldset className="grid gap-1 sm:grid-cols-2">
      <legend className="label mb-1">Lightspeed statuses in this view</legend>
      {statuses.map((s) => (
        <label key={s.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="status_ids" value={s.id} defaultChecked={selected.includes(s.id)} className="h-4 w-4" />
          <span className="inline-block h-2.5 w-2.5 rounded-full border border-border" style={{ background: s.htmlColor ?? "transparent" }} aria-hidden />
          {s.name}
          <span className="text-xs text-muted">#{s.id}</span>
        </label>
      ))}
      {statuses.length === 0 && <p className="text-sm text-muted" id={`${prefix}-none`}>No statuses synced yet — open Work orders and press Sync from Lightspeed first.</p>}
    </fieldset>
  );

  return (
    <div>
      <PageHeader title="Work-order views" subtitle="Cut the Lightspeed work-order list into the views your team thinks in. A view is a name plus the statuses it shows; a status can be in several views." />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={editing ? `Edit “${editing.name}”` : "New view"} action={editing ? <a href="/app/settings/views" className="btn btn-sm">Cancel</a> : undefined}>
          <form action={saveViewAction} className="space-y-4">
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <Field label="Name" htmlFor="view_name" hint="e.g. Service: in progress · Ready for pickup · Builds · Waiting on parts">
              <input id="view_name" name="name" required className="input" defaultValue={editing?.name ?? ""} />
            </Field>
            {statusPicker(editing?.statusIds ?? [], "new")}
            <button type="submit" className="btn btn-primary">{editing ? "Save view" : "Create view"}</button>
          </form>
        </Card>
        <div className="space-y-6">
          <Card title={`Your views (${views.length})`}>
            {views.length === 0 ? <p className="text-sm text-muted">None yet.</p> : (
              <ul className="divide-y divide-border text-sm">
                {views.map((v) => (
                  <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div>
                      <p className="font-medium">{v.name}</p>
                      <p className="text-xs text-muted">{v.statusIds.map((id) => statuses.find((s) => s.id === id)?.name ?? `#${id}`).join(", ") || "no statuses"}</p>
                    </div>
                    <div className="flex gap-1">
                      <a href={`/app/settings/views?edit=${v.id}`} className="btn btn-sm">Edit</a>
                      <form action={deleteViewAction.bind(null, v.id)}><ConfirmButton className="btn btn-danger btn-sm" message={`Delete the view “${v.name}”? Work orders are not affected.`}>Delete</ConfirmButton></form>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {statuses.length > 0 && (
            <Card title={`Statuses in no view (${free.length})`}>
              {free.length === 0 ? <p className="text-sm text-muted">Every status is covered.</p> : <p className="text-sm text-muted">{free.map((s) => s.name).join(" · ")}</p>}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
