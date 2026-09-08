import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { googleEnabled } from "@/lib/google-auth";
import { sp, type SearchParams } from "@/lib/flash";
import { KickstandLogo } from "@/components/logo";
import { Alert, Card, Field } from "@/components/ui";
import { passwordLoginAction, requestLoginAction } from "./actions";

export const metadata = { title: { absolute: "Sign in · Kickstand" } };

const ERRORS: Record<string, string> = {
  invalid: "That link is invalid or has expired. Request a new one.",
  google: "Google sign-in didn't complete. Please try again.",
  google_off: "Google sign-in isn't set up on this server yet.",
  domain: "Use your Biktrix Google account, not a personal one.",
  not_staff: "That Google account isn't on the staff list yet. Ask a manager to add you under Settings › Staff, then try again.",
  password: "That email and password don't match. If you haven't set a password yet, sign in with Google (or a link) and set one under your account.",
  locked: "Too many attempts. The password is locked for 15 minutes — sign in with Google meanwhile, or wait and try again.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  if (await getCurrentUser()) redirect("/app");
  const sent = sp(q.sent) === "1";
  const error = sp(q.error);
  const devLink = sp(q.dev);
  const google = googleEnabled();
  const linkMode = sp(q.mode) === "link" || sent;
  const prefill = sp(q.email) ?? "";
  // Password is always offered. The emailed link is behind a small link when Google is on (and always shown locally).
  const showEmail = linkMode || !google || process.env.NODE_ENV !== "production";
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-10">
      <div className="mb-8 flex flex-col items-center gap-3">
        <KickstandLogo size={40} />
        <p className="text-xs font-medium uppercase tracking-widest text-muted">Biktrix staff</p>
      </div>
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
        {!linkMode && (
          <form action={passwordLoginAction} className={`space-y-4 ${google ? "mt-6 border-t border-border pt-5" : ""}`}>
            {google && <p className="text-center text-xs uppercase tracking-wide text-muted">or with a password</p>}
            <Field label="Work email" htmlFor="pw_email">
              <input id="pw_email" name="email" type="email" required autoComplete="username" className="input" placeholder="you@biktrix.com" defaultValue={prefill} />
            </Field>
            <Field label="Password" htmlFor="pw_password">
              <input id="pw_password" name="password" type="password" required autoComplete="current-password" className="input" />
            </Field>
            <button className={`btn btn-block ${google ? "" : "btn-primary"}`} type="submit">Sign in</button>
            <p className="text-center text-xs text-muted">
              No password yet, or forgot it? Sign in with Google{showEmail ? " or a link" : <> or <a className="underline" href="/login?mode=link">an emailed link</a></>}, then set one under your name.
            </p>
          </form>
        )}
        {showEmail && <div className="my-5 border-t border-border pt-4 text-center text-xs uppercase tracking-wide text-muted">{linkMode ? "Sign-in link" : "or by emailed link"}</div>}
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
            <Field label="Work email" htmlFor="email" hint="We email a one-time link. Staff accounts only.">
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
