import { db } from "@/db/client";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Card, Field, Flash, PageHeader } from "@/components/ui";
import { assignableRoles, canManage, hasRole, listStaff, requireUser, ROLE_LABEL, roleLabel } from "@/lib/auth";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { googleEnabled } from "@/lib/google-auth";
import { listShowrooms } from "@/lib/showroom";
import { clearStaffPasswordAction, deleteStaffAction, inviteStaffAction, setStaffActiveAction, updateStaffAction } from "../../actions";

export const metadata = { title: "Staff" };

/** Invite people by email; they get a sign-in link. Admins manage every store; managers invite into their own. */
export default async function StaffSettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const user = await requireUser("manager");
  const admin = hasRole(user.role, "admin");
  const options = assignableRoles(user.role);
  const showroom = await currentShowroom(user);
  const [staff, showrooms] = await Promise.all([listStaff(), listShowrooms(db)]);
  const storeName = (id: string | null) => (id ? showrooms.find((s) => s.id === id)?.name ?? "—" : "All stores");
  const visible = admin ? staff : staff.filter((s) => s.showroomId === showroom.id);
  const google = googleEnabled();
  const emailKey = !!process.env.RESEND_API_KEY;

  return (
    <div>
      <PageHeader
        title="Staff"
        subtitle={google
          ? "Add someone by work email; they sign in with their Biktrix Google account, then can set a password under Your account. Deactivate keeps the account but signs them out everywhere; Delete removes it."
          : "People sign in with a link we email them — no passwords. Invite by work email. Deactivate keeps the account but signs them out everywhere; Delete removes it."}
      />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      {!google && !emailKey && <div className="mb-4"><Badge tone="warn">No email key set: invitations and sign-in links are written to the server log instead of being emailed.</Badge></div>}
      <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        <Card title={google ? "Add someone" : "Invite someone"}>
          <form action={inviteStaffAction} className="space-y-3">
            <Field label="Work email" htmlFor="inv_email"><input id="inv_email" name="email" type="email" required className="input" placeholder={`name@${process.env.AUTH_ALLOWED_DOMAIN ?? "biktrix.com"}`} /></Field>
            <Field label="Name" htmlFor="inv_name"><input id="inv_name" name="name" className="input" placeholder="As it should appear on the timeline" /></Field>
            <Field label="Role" htmlFor="inv_role">
              <select id="inv_role" name="role" className="input" defaultValue="staff">
                {options.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </Field>
            <Field label="Store" htmlFor="inv_store">
              <select id="inv_store" name="showroom_id" className="input" defaultValue={showroom.id}>
                {showrooms.filter((s) => admin || s.id === showroom.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                {admin && <option value="">All stores (admins)</option>}
              </select>
            </Field>
            <button type="submit" className="btn btn-primary">{google ? "Add to staff" : "Send invitation"}</button>
          </form>
        </Card>
        <Card title={`People (${visible.length})`} className="min-w-0">
          <div className="-mx-2 overflow-x-auto px-2">
            <table className="table">
              <thead><tr><th>Person</th><th>Role · store</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {visible.map((s) => {
                  const editable = admin && s.id !== user.id && canManage(user.role, s.role);
                  const locked = !!s.passwordLockedUntil && s.passwordLockedUntil > new Date();
                  return (
                    <tr key={s.id} className={s.active ? undefined : "opacity-60"}>
                      <td>
                        <div className="font-medium">{s.name}{s.id === user.id && <span className="ml-1 text-xs text-muted">(you)</span>}</div>
                        <div className="text-xs text-muted">{s.email}</div>
                      </td>
                      <td>
                        {editable ? (
                          <form action={updateStaffAction.bind(null, s.id)} className="flex flex-wrap items-center gap-1">
                            <input type="hidden" name="name" value={s.name} />
                            <select name="role" defaultValue={s.role} className="input h-8 w-auto py-0 text-sm">
                              {options.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                            </select>
                            <select name="showroom_id" defaultValue={s.showroomId ?? ""} className="input h-8 w-auto py-0 text-sm">
                              {showrooms.map((sh) => <option key={sh.id} value={sh.id}>{sh.name}</option>)}
                              <option value="">All stores</option>
                            </select>
                            <button type="submit" className="btn btn-sm">Save</button>
                          </form>
                        ) : (
                          <div className="text-sm">{roleLabel(s.role)} <span className="text-muted">· {storeName(s.showroomId)}</span></div>
                        )}
                      </td>
                      <td>
                        <div className="flex flex-col items-start gap-1">
                          {s.active ? <Badge tone="ok">active</Badge> : <Badge>deactivated</Badge>}
                          <span className="text-xs text-muted">{s.passwordHash ? (locked ? "password locked" : "password set") : "no password"}</span>
                        </div>
                      </td>
                      <td className="text-right">
                        <div className="flex flex-wrap justify-end gap-1">
                          {s.active && (
                            <form action={inviteStaffAction}>
                              <input type="hidden" name="email" value={s.email} /><input type="hidden" name="name" value={s.name} /><input type="hidden" name="role" value={s.role} /><input type="hidden" name="showroom_id" value={s.showroomId ?? ""} />
                              <button type="submit" className="btn btn-sm" title="Email a fresh sign-in link">Send link</button>
                            </form>
                          )}
                          {editable && s.passwordHash && (
                            <form action={clearStaffPasswordAction.bind(null, s.id)}><ConfirmButton className="btn btn-sm" message={`Remove ${s.name}'s password? They sign in with Google or a link and set a new one.`}>Reset password</ConfirmButton></form>
                          )}
                          {editable && (
                            s.active
                              ? <form action={setStaffActiveAction.bind(null, s.id, false)}><ConfirmButton className="btn btn-danger btn-sm" message={`Deactivate ${s.name}? They are signed out everywhere and can't sign in until re-activated.`}>Deactivate</ConfirmButton></form>
                              : <form action={setStaffActiveAction.bind(null, s.id, true)}><button type="submit" className="btn btn-sm">Re-activate</button></form>
                          )}
                          {editable && (
                            <form action={deleteStaffAction.bind(null, s.id)}><ConfirmButton className="btn btn-danger btn-sm" message={`Delete ${s.name} (${s.email}) permanently? Deactivate instead if they might come back.`}>Delete</ConfirmButton></form>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
