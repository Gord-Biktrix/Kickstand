import { db } from "@/db/client";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Card, Field, Flash, PageHeader } from "@/components/ui";
import { hasRole, listStaff, requireUser } from "@/lib/auth";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { listShowrooms } from "@/lib/showroom";
import { inviteStaffAction, setStaffActiveAction, updateStaffAction } from "../../actions";

export const metadata = { title: "Staff" };

/** Invite people by email; they get a sign-in link. Admins manage every store; managers invite into their own. */
export default async function StaffSettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const user = await requireUser("manager");
  const admin = hasRole(user.role, "admin");
  const showroom = await currentShowroom(user);
  const [staff, showrooms] = await Promise.all([listStaff(), listShowrooms(db)]);
  const storeName = (id: string | null) => (id ? showrooms.find((s) => s.id === id)?.name ?? "—" : "All stores");
  const visible = admin ? staff : staff.filter((s) => s.showroomId === showroom.id);
  const emailKey = !!process.env.RESEND_API_KEY;

  return (
    <div>
      <PageHeader title="Staff" subtitle="People sign in with a link we email them — no passwords. Invite by work email; deactivating signs someone out everywhere." />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      {!emailKey && <div className="mb-4"><Badge tone="warn">No email key set: invitations and sign-in links are written to the server log instead of being emailed.</Badge></div>}
      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <Card title="Invite someone">
          <form action={inviteStaffAction} className="space-y-3">
            <Field label="Work email" htmlFor="inv_email"><input id="inv_email" name="email" type="email" required className="input" placeholder={`name@${process.env.AUTH_ALLOWED_DOMAIN ?? "biktrix.com"}`} /></Field>
            <Field label="Name" htmlFor="inv_name"><input id="inv_name" name="name" className="input" placeholder="As it should appear on the timeline" /></Field>
            <Field label="Role" htmlFor="inv_role" hint="Staff: book, receive, hand over. Manager: plus capacity, settings, extensions, delete. Admin: every store.">
              <select id="inv_role" name="role" className="input" defaultValue="staff">
                <option value="staff">Staff</option>
                <option value="manager">Manager</option>
                {admin && <option value="admin">Admin</option>}
              </select>
            </Field>
            <Field label="Store" htmlFor="inv_store">
              <select id="inv_store" name="showroom_id" className="input" defaultValue={showroom.id}>
                {showrooms.filter((s) => admin || s.id === showroom.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                {admin && <option value="">All stores (admins)</option>}
              </select>
            </Field>
            <button type="submit" className="btn btn-primary">Send invitation</button>
          </form>
        </Card>
        <Card title={`People (${visible.length})`}>
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Store</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {visible.map((s) => (
                  <tr key={s.id} className={s.active ? undefined : "opacity-60"}>
                    <td className="font-medium">{s.name}{s.id === user.id && <span className="ml-1 text-xs text-muted">(you)</span>}</td>
                    <td className="text-sm">{s.email}</td>
                    <td>
                      {admin ? (
                        <form action={updateStaffAction.bind(null, s.id)} className="flex items-center gap-1">
                          <input type="hidden" name="name" value={s.name} />
                          <select name="role" defaultValue={s.role} className="input h-8 w-auto py-0 text-sm" disabled={s.id === user.id}>
                            <option value="staff">Staff</option><option value="manager">Manager</option><option value="admin">Admin</option>
                          </select>
                          <select name="showroom_id" defaultValue={s.showroomId ?? ""} className="input h-8 w-auto py-0 text-sm">
                            {showrooms.map((sh) => <option key={sh.id} value={sh.id}>{sh.name}</option>)}
                            <option value="">All stores</option>
                          </select>
                          <button type="submit" className="btn btn-sm">Save</button>
                        </form>
                      ) : <span className="capitalize">{s.role}</span>}
                    </td>
                    <td className="text-sm">{admin ? "" : storeName(s.showroomId)}</td>
                    <td>{s.active ? <Badge tone="ok">active</Badge> : <Badge>deactivated</Badge>}</td>
                    <td className="text-right">
                      <div className="flex justify-end gap-1">
                        {s.active && (
                          <form action={inviteStaffAction}>
                            <input type="hidden" name="email" value={s.email} /><input type="hidden" name="name" value={s.name} /><input type="hidden" name="role" value={s.role} /><input type="hidden" name="showroom_id" value={s.showroomId ?? ""} />
                            <button type="submit" className="btn btn-sm" title="Email a fresh sign-in link">Resend link</button>
                          </form>
                        )}
                        {admin && s.id !== user.id && (
                          s.active
                            ? <form action={setStaffActiveAction.bind(null, s.id, false)}><ConfirmButton className="btn btn-danger btn-sm" message={`Deactivate ${s.name}? They are signed out everywhere and can't sign in until re-activated.`}>Deactivate</ConfirmButton></form>
                            : <form action={setStaffActiveAction.bind(null, s.id, true)}><button type="submit" className="btn btn-sm">Re-activate</button></form>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
