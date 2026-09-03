import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { sp, type SearchParams } from "@/lib/flash";
import { Alert, Card, Field } from "@/components/ui";
import { requestLoginAction } from "./actions";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  if (await getCurrentUser()) redirect("/app");
  const sent = sp(q.sent) === "1";
  const error = sp(q.error);
  const devLink = sp(q.dev);
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-10">
      <p className="mb-6 text-center text-sm font-semibold uppercase tracking-widest text-accent">Biktrix Pickups</p>
      <Card title="Staff sign in">
        {error === "invalid" && <div className="mb-3"><Alert tone="danger">That link is invalid or has expired. Request a new one.</Alert></div>}
        {sent ? (
          <div className="space-y-3 text-sm">
            <Alert tone="ok">If that address is on the staff list, a sign-in link is on its way. It expires in 15 minutes.</Alert>
            {devLink && (
              <p className="break-all rounded-lg bg-warn-soft p-3 text-xs text-warn">
                Development only — <a className="underline" href={devLink}>open the magic link</a>
              </p>
            )}
          </div>
        ) : (
          <form action={requestLoginAction} className="space-y-4">
            <Field label="Work email" htmlFor="email" hint="Biktrix addresses on the pilot allow-list only.">
              <input id="email" name="email" type="email" required autoComplete="email" className="input" placeholder="you@biktrix.com" />
            </Field>
            <button className="btn btn-primary btn-block" type="submit">Email me a sign-in link</button>
          </form>
        )}
      </Card>
    </main>
  );
}
