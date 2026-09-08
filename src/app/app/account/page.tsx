import { Alert, Card, Field, Flash, PageHeader } from "@/components/ui";
import { requireUser, roleLabel } from "@/lib/auth";
import { sp, type SearchParams } from "@/lib/flash";
import { MIN_PASSWORD_LENGTH } from "@/lib/passwords";
import { clearOwnPasswordAction, setPasswordAction } from "../actions";

export const metadata = { title: "Your account" };

/** Where a signed-in person sets a password for themselves (alongside Google / the emailed link). */
export default async function AccountPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const user = await requireUser("staff");
  const hasPassword = !!user.passwordHash;
  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="Your account" subtitle={`${user.name} · ${roleLabel(user.role)} · ${user.email}`} />
      <Flash ok={sp(q.ok)} error={sp(q.error)} />
      <Card title={hasPassword ? "Change your password" : "Set a password"}>
        <p className="mb-4 text-sm text-muted">
          {hasPassword
            ? "You can sign in with this password or with Google. Changing it signs out your other devices."
            : "Optional. You can keep signing in with Google; a password is a second way in for shared shop computers."}
        </p>
        <form action={setPasswordAction} className="space-y-3">
          <Field label="New password" htmlFor="pw1" hint={`At least ${MIN_PASSWORD_LENGTH} characters. A short sentence works well.`}>
            <input id="pw1" name="password" type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" className="input" />
          </Field>
          <Field label="Repeat it" htmlFor="pw2">
            <input id="pw2" name="password2" type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" className="input" />
          </Field>
          <button type="submit" className="btn btn-primary">{hasPassword ? "Change password" : "Set password"}</button>
        </form>
        {hasPassword && (
          <form action={clearOwnPasswordAction} className="mt-6 border-t border-border pt-4">
            <Alert tone="neutral">Prefer Google only? Removing the password leaves Google and the emailed link as your ways in.</Alert>
            <button type="submit" className="btn btn-sm mt-3">Remove my password</button>
          </form>
        )}
      </Card>
    </div>
  );
}
