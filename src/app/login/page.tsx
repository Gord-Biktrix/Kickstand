import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { googleEnabled } from "@/lib/google-auth";
import { sp, type SearchParams } from "@/lib/flash";
import { Alert, Card, Field } from "@/components/ui";
import { requestLoginAction } from "./actions";

export const metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  invalid: "That link is invalid or has expired. Request a new one.",
  google: "Google sign-in didn't complete. Please try again.",
  google_off: "Google sign-in isn't set up on this server yet.",
  domain: "Use your Biktrix Google account, not a personal one.",
  not_staff: "That Google account isn't on the staff list yet. Ask a manager to add you under Settings › Staff, then try again.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  if (await getCurrentUser()) redirect("/app");
  const sent = sp(q.sent) === "1";
  const error = sp(q.error);
  const devLink = sp(q.dev);
  const google = googleEnabled();
  // The emailed link stays available when Google isn't configured, and as a developer fallback locally.
  const showEmail = !google || process.env.NODE_ENV !== "production";
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-10">
      <p className="mb-6 text-center text-sm font-semibold uppercase tracking-widest text-accent">Biktrix Pickups</p>
      <Card title="Staff sign in">
        {error && ERRORS[error] && <div className="mb-3"><Alert tone="danger">{ERRORS[error]}</Alert></div>}
        {google && (
          <div className="space-y-3">
            <a href="/auth/google" className="btn btn-primary btn-block">
              <GoogleMark />
              Sign in with Google
            </a>
            <p className="text-center text-xs text-muted">Use your Biktrix Google account. New here? A manager adds you under Settings › Staff first.</p>
          </div>
        )}
        {google && showEmail && <div className="my-5 border-t border-line pt-4 text-center text-xs uppercase tracking-wide text-muted">or (development)</div>}
        {showEmail && (sent ? (
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
            <Field label="Work email" htmlFor="email" hint="Staff accounts only.">
              <input id="email" name="email" type="email" required autoComplete="email" className="input" placeholder="you@biktrix.com" />
            </Field>
            <button className={`btn btn-block ${google ? "" : "btn-primary"}`} type="submit">Email me a sign-in link</button>
          </form>
        ))}
      </Card>
    </main>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48" className="mr-2 inline-block">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.5 13.3l7.9 6.1C12.3 13.7 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-2.8-.4-4H24v8.1h12.9c-.3 2.1-1.7 5.3-4.8 7.4l7.4 5.7c4.4-4.1 7-10.1 7-17.2z" />
      <path fill="#FBBC05" d="M10.4 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.5 10.7l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.3 0 11.7-2.1 15.5-5.7l-7.4-5.7c-2 1.4-4.7 2.4-8.1 2.4-6.3 0-11.7-4.2-13.6-10l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}
