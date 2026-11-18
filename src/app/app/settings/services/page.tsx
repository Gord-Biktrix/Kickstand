import { db } from "@/db/client";
import { Card, Flash, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { LightspeedClient, lightspeedEnabled } from "@/lib/lightspeed";
import { loadServiceItems, pickTiles, type ServiceItem } from "@/lib/service-items";
import { listShowrooms } from "@/lib/showroom";
import { lightspeedReason } from "@/lib/workorder-lines";
import { DEFAULT_CHECKS } from "@/lib/job-track";
import { saveChecklistsAction, saveServiceTilesAction } from "../../actions";

export const metadata = { title: "Services" };

const money = (n: number) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n);

/** Which Lightspeed items show as service and labour tiles on New ticket, for this store. */
export default async function ServicesSettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const user = await requireUser("manager");
  const showroom = await currentShowroom(user);
  let all: ServiceItem[] = [];
  let error = "";
  if (lightspeedEnabled(showroom)) {
    try {
      all = await loadServiceItems(new LightspeedClient(db));
    } catch (err) {
      error = lightspeedReason(err);
    }
  } else error = "Lightspeed isn't switched on for this store.";
  const others = (await listShowrooms(db)).filter((x) => x.id !== showroom.id).map((x) => `${x.name} ${x.slug}`);
  const chosen = showroom.settings.workshop_service_items;
  const suggested = new Set(pickTiles(all, { selected: null, store: `${showroom.name} ${showroom.slug}`, otherStores: others }).map((i) => i.itemId));
  const ticked = new Set(chosen ?? [...suggested]);
  const lists = showroom.settings.inspection_checklists;

  return (
    <div>
      <PageHeader title="Services" subtitle={`The tiles on New ticket at ${showroom.name}: tick the Lightspeed items staff should tap. Each one goes on the work order as a line at its Lightspeed price.`} />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      {error ? (
        <Card><p className="text-sm text-red-700">Couldn&apos;t read Lightspeed ({error}).</p></Card>
      ) : (
        <Card
          title={chosen ? `${chosen.length} picked` : `Kickstand's suggestions (${suggested.size}) — save to make it your list`}
          action={chosen ? <form action={saveServiceTilesAction.bind(null, true)}><button type="submit" className="btn btn-sm">Back to suggestions</button></form> : undefined}
        >
          <p className="mb-3 text-sm text-muted">
            Names are tidied on the tiles (&ldquo;Service Package Tune Up Vancouver&rdquo; shows as &ldquo;Tune Up&rdquo;) and another store&apos;s version is hidden. A time in the name (&ldquo;30 min&rdquo;, &ldquo;1h30&rdquo;) is used for ready-by; otherwise the repair time in Settings › Program.
          </p>
          <form action={saveServiceTilesAction.bind(null, false)} className="space-y-3">
            <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {all.map((i) => (
                <li key={i.itemId}>
                  <label className="flex min-h-10 items-center gap-3 text-sm">
                    <input type="checkbox" name="item" value={i.itemId} defaultChecked={ticked.has(i.itemId)} className="h-5 w-5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{i.name}</span>
                    <span className="shrink-0 text-muted tabular-nums">{i.price != null ? money(i.price) : ""}</span>
                  </label>
                </li>
              ))}
            </ul>
            <button type="submit" className="btn btn-primary">Save services</button>
          </form>
        </Card>
      )}
      {!error && (
        <Card title="Inspection checklists">
          <form action={saveChecklistsAction} className="space-y-4">
            <ul className="grid gap-4 md:grid-cols-2">
              {all.filter((i) => ticked.has(i.itemId)).map((i) => (
                <li key={i.itemId}>
                  <label htmlFor={`cl-${i.itemId}`} className="text-sm font-bold">{i.name}</label>
                  <textarea id={`cl-${i.itemId}`} name={`cl:${i.itemId}`} rows={5} defaultValue={(lists[i.itemId] ?? []).join("\n")} placeholder="One check per line" className="input mt-1 w-full" />
                </li>
              ))}
              <li>
                <label htmlFor="cl-default" className="text-sm font-bold">Any other job</label>
                <textarea id="cl-default" name="cl:default" rows={5} defaultValue={(showroom.settings.inspection_default ?? DEFAULT_CHECKS).join("\n")} className="input mt-1 w-full" />
              </li>
            </ul>
            <button type="submit" className="btn btn-primary">Save checklists</button>
          </form>
        </Card>
      )}
    </div>
  );
}
