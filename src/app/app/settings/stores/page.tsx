import { db } from "@/db/client";
import { Alert, Badge, Card, Field, Flash, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { sp, type SearchParams } from "@/lib/flash";
import { getConnection, LightspeedClient } from "@/lib/lightspeed";
import { listShowrooms } from "@/lib/showroom";
import { listWorkorderStatuses } from "@/lib/workorders";
import { createShowroomAction, refreshLightspeedStatusesAction, setLightspeedLinkAction, updateShowroomAction } from "../../actions";

export const metadata = { title: "Stores" };

const TIMEZONES = ["America/Vancouver", "America/Edmonton", "America/Regina", "America/Winnipeg", "America/Toronto", "America/Halifax"];

/**
 * Stores and their Lightspeed links. Work orders and special orders live per Lightspeed *shop*, so
 * each store gets its own shop, employee and "Pickup: …" statuses; the save refuses anything another
 * store already uses. Admins only (any store).
 */
export default async function StoresPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  await requireUser("admin");
  const stores = await listShowrooms(db);
  const statuses = await listWorkorderStatuses(db);
  const connected = !!(await getConnection(db));
  let shops: { shopID: string; name: string }[] = [];
  let employees: { employeeID: string; name: string }[] = [];
  let lsError: string | null = null;
  if (connected) {
    try {
      const client = new LightspeedClient(db);
      [shops, employees] = await Promise.all([client.listShops(), client.listEmployees()]);
    } catch (err) {
      lsError = err instanceof Error ? err.message : String(err);
    }
  }
  const usedShops = new Map(stores.flatMap((s) => (s.settings.lightspeed.shop_id ? [[s.settings.lightspeed.shop_id, s.name] as const] : [])));
  const usedStatuses = new Map(stores.flatMap((s) => Object.values(s.settings.lightspeed.statuses).map((id) => [id, s.name] as const)));

  return (
    <div>
      <PageHeader title="Stores" subtitle="Each store has its own hours, capacity, staff and Lightspeed shop. Work orders and special orders stay inside their shop, and each store maps its own Pickup statuses, so stores never intersect." />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      {!connected && <div className="mb-4"><Alert tone="warn">Lightspeed isn&apos;t connected on this server yet, so shop and employee lists can&apos;t be loaded. Ids can still be typed in.</Alert></div>}
      {lsError && <div className="mb-4"><Alert tone="danger">Couldn&apos;t load shops from Lightspeed: {lsError}</Alert></div>}

      <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        <Card title="Add a store">
          <form action={createShowroomAction} className="space-y-3">
            <Field label="Name" htmlFor="st_name"><input id="st_name" name="name" required className="input" placeholder="Biktrix Saskatoon" /></Field>
            <Field label="Short id" htmlFor="st_slug" hint="Used in links and the store switcher; letters and dashes. Left blank, it comes from the name."><input id="st_slug" name="slug" className="input" placeholder="saskatoon" pattern="[a-z0-9-]*" /></Field>
            <Field label="Time zone" htmlFor="st_tz">
              <select id="st_tz" name="timezone" className="input" defaultValue="America/Regina">{TIMEZONES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
            </Field>
            <Field label="Address" htmlFor="st_addr" hint="Goes in the customer's booking text."><input id="st_addr" name="address_line" className="input" placeholder="123 Example St, Saskatoon, SK" /></Field>
            <Field label="Phone" htmlFor="st_phone"><input id="st_phone" name="phone" className="input" placeholder="306-555-0100" /></Field>
            <Field label="Copy hours & settings from" htmlFor="st_copy">
              <select id="st_copy" name="copy_from" className="input" defaultValue={stores[0]?.slug ?? ""}>
                <option value="">Start empty</option>
                {stores.map((s) => <option key={s.id} value={s.slug}>{s.name}</option>)}
              </select>
            </Field>
            <button type="submit" className="btn btn-primary">Create store</button>
          </form>
        </Card>

        <div className="space-y-6">
          {stores.map((s) => {
            const ls = s.settings.lightspeed;
            const shopName = shops.find((x) => Number(x.shopID) === ls.shop_id)?.name;
            return (
              <Card
                key={s.id}
                title={<span className="inline-flex items-center gap-2">{s.name} <span className="text-xs font-normal text-muted">/{s.slug}</span></span>}
                action={ls.enabled ? <Badge tone="ok">Lightspeed on · shop {ls.shop_id}{shopName ? ` (${shopName})` : ""}</Badge> : <Badge>Lightspeed off</Badge>}
              >
                <div className="grid gap-6 md:grid-cols-2">
                  <form action={updateShowroomAction.bind(null, s.id)} className="space-y-3">
                    <h3 className="text-sm font-semibold">Details</h3>
                    <Field label="Name" htmlFor={`name_${s.id}`}><input id={`name_${s.id}`} name="name" defaultValue={s.name} required className="input" /></Field>
                    <Field label="Time zone" htmlFor={`tz_${s.id}`}>
                      <select id={`tz_${s.id}`} name="timezone" className="input" defaultValue={s.timezone}>{[...new Set([s.timezone, ...TIMEZONES])].map((t) => <option key={t} value={t}>{t}</option>)}</select>
                    </Field>
                    <Field label="Address" htmlFor={`addr_${s.id}`}><input id={`addr_${s.id}`} name="address_line" defaultValue={s.addressLine} className="input" /></Field>
                    <Field label="Phone" htmlFor={`phone_${s.id}`}><input id={`phone_${s.id}`} name="phone" defaultValue={s.phone ?? ""} className="input" /></Field>
                    <button type="submit" className="btn btn-sm">Save details</button>
                  </form>

                  <form action={setLightspeedLinkAction.bind(null, s.id)} className="space-y-3">
                    <h3 className="text-sm font-semibold">Lightspeed link</h3>
                    <Field label="Shop" htmlFor={`shop_${s.id}`} hint="Work orders and special orders are read from and written to this shop only.">
                      {shops.length ? (
                        <select id={`shop_${s.id}`} name="shop_id" className="input" defaultValue={ls.shop_id ?? ""}>
                          <option value="">— not linked —</option>
                          {shops.map((sh) => {
                            const owner = usedShops.get(Number(sh.shopID));
                            const mine = Number(sh.shopID) === ls.shop_id;
                            return <option key={sh.shopID} value={sh.shopID} disabled={!!owner && !mine}>{sh.name} (#{sh.shopID}){owner && !mine ? ` · used by ${owner}` : ""}</option>;
                          })}
                        </select>
                      ) : <input id={`shop_${s.id}`} name="shop_id" type="number" defaultValue={ls.shop_id ?? ""} className="input" placeholder="Lightspeed shop id" />}
                    </Field>
                    <Field label="Work orders assigned to" htmlFor={`emp_${s.id}`}>
                      {employees.length ? (
                        <select id={`emp_${s.id}`} name="employee_id" className="input" defaultValue={ls.employee_id ?? ""}>
                          <option value="">— nobody —</option>
                          {employees.map((e) => <option key={e.employeeID} value={e.employeeID}>{e.name} (#{e.employeeID})</option>)}
                        </select>
                      ) : <input id={`emp_${s.id}`} name="employee_id" type="number" defaultValue={ls.employee_id ?? ""} className="input" placeholder="Lightspeed employee id" />}
                    </Field>
                    <StatusSelect id={`open_${s.id}`} name="open_status_id" label="New work order starts in" value={ls.open_status_id} statuses={statuses} used={usedStatuses} me={s.name} allowNone={false} />
                    <StatusSelect id={`booked_${s.id}`} name="booked_status_id" label="When a pickup is booked" value={ls.statuses.booked ?? null} statuses={statuses} used={usedStatuses} me={s.name} hint="Create a status like “Pickup: Booked (SK)” in Lightspeed for each store — statuses are account-wide, so each store needs its own." />
                    <StatusSelect id={`done_${s.id}`} name="completed_status_id" label="When the bike is handed over" value={ls.statuses.completed ?? null} statuses={statuses} used={usedStatuses} me={s.name} />
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={ls.enabled} className="h-4 w-4" /> Link on — create and update work orders in this shop</label>
                    <div className="flex items-center gap-2">
                      <button type="submit" className="btn btn-primary btn-sm">Save Lightspeed link</button>
                      <button type="submit" formAction={refreshLightspeedStatusesAction} className="btn btn-sm" title="Reload the status list from Lightspeed">Refresh statuses</button>
                    </div>
                  </form>
                </div>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StatusSelect({ id, name, label, value, statuses, used, me, hint, allowNone = true }: {
  id: string; name: string; label: string; value: number | null;
  statuses: { id: number; name: string }[]; used: Map<number, string>; me: string; hint?: string; allowNone?: boolean;
}) {
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      {statuses.length ? (
        <select id={id} name={name} className="input" defaultValue={value ?? ""}>
          {allowNone && <option value="">— none —</option>}
          {statuses.map((st) => {
            const owner = used.get(Number(st.id));
            const taken = !!owner && owner !== me && name !== "open_status_id";
            return <option key={st.id} value={st.id} disabled={taken}>{st.name} (#{st.id}){taken ? ` · used by ${owner}` : ""}</option>;
          })}
        </select>
      ) : <input id={id} name={name} type="number" defaultValue={value ?? ""} className="input" placeholder="Status id — press Refresh statuses to load names" />}
    </Field>
  );
}
