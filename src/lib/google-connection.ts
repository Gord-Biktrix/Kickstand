/**
 * "Connect Google Calendar" (Settings › Stores): an admin signs in with Google once and Kickstand writes
 * booking events as that account, like BookIt did, onto whichever of its calendars each store picks. Uses the
 * same Google OAuth client as Sign in with Google (GOOGLE_CLIENT_ID / SECRET), asking for offline access so it
 * gets a refresh token, which is stored encrypted. No library: plain OAuth 2.0 calls.
 *
 * Google Cloud setup (once): enable the Google Calendar API; on the OAuth consent screen add the scopes below;
 * on the OAuth client add the redirect URI from calendarRedirectUri().
 */
import { eq } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { googleConnections, type GoogleConnection } from "@/db/schema";
import { checkGoogleClaims, googleEnabled, type GoogleClaims } from "./google-auth";
import { logger } from "./logger";
import { baseUrl } from "./messages";
import { decryptToken, encryptToken } from "./tokens";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TOKENINFO_ENDPOINT = "https://oauth2.googleapis.com/tokeninfo";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";

export const CALENDAR_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

export const calendarConnectEnabled = googleEnabled;

export function calendarRedirectUri(): string {
  return `${baseUrl()}/auth/google/calendar/callback`;
}

export function calendarAuthUrl(state: string): string {
  const u = new URL(AUTH_ENDPOINT);
  u.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID ?? "");
  u.searchParams.set("redirect_uri", calendarRedirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", CALENDAR_SCOPES.join(" "));
  u.searchParams.set("state", state);
  // offline + consent: Google only returns a refresh token on a fresh consent.
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent select_account");
  u.searchParams.set("include_granted_scopes", "true");
  const domain = process.env.AUTH_ALLOWED_DOMAIN;
  if (domain) u.searchParams.set("hd", domain);
  return u.toString();
}

export type CalendarGrant = { ok: true; email: string; refreshToken: string; scope: string } | { ok: false; reason: string };

/** Exchange the code for tokens; check who it is (Workspace domain) and that calendar access was granted. */
export async function exchangeCalendarCode(code: string, fetchImpl: typeof fetch = fetch): Promise<CalendarGrant> {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: calendarRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) return { ok: false, reason: "Google didn't accept the sign-in. Please try again." };
  const t = (await res.json()) as { id_token?: string; refresh_token?: string; scope?: string };
  if (!t.refresh_token) return { ok: false, reason: "Google didn't give Kickstand lasting access. Remove Kickstand under myaccount.google.com › Security › Third-party access, then connect again." };
  const scope = t.scope ?? "";
  if (!scope.includes("calendar.events")) return { ok: false, reason: "Calendar access wasn't granted. Connect again and tick the calendar boxes." };
  if (!t.id_token) return { ok: false, reason: "Google didn't say which account this is. Please try again." };
  const info = await fetchImpl(`${TOKENINFO_ENDPOINT}?id_token=${encodeURIComponent(t.id_token)}`);
  if (!info.ok) return { ok: false, reason: "Couldn't check the Google account. Please try again." };
  const who = checkGoogleClaims((await info.json()) as GoogleClaims, { clientId: process.env.GOOGLE_CLIENT_ID ?? "", domain: process.env.AUTH_ALLOWED_DOMAIN ?? "" });
  if (!who.ok) return { ok: false, reason: who.reason === "domain" ? "Use a Biktrix Google account." : "Couldn't check the Google account. Please try again." };
  return { ok: true, email: who.email, refreshToken: t.refresh_token, scope };
}

export async function getGoogleConnection(dbx: DbOrTx): Promise<GoogleConnection | null> {
  const [row] = await dbx.select().from(googleConnections).limit(1);
  return row ?? null;
}

/** Replace any previous connection with this one. */
export async function saveGoogleConnection(dbx: DbOrTx, args: { email: string; refreshToken: string; scope: string; connectedBy: string }): Promise<void> {
  await dbx.delete(googleConnections);
  await dbx.insert(googleConnections).values({ email: args.email, refreshTokenEnc: encryptToken(args.refreshToken), scope: args.scope, connectedBy: args.connectedBy });
}

/** Forget the connection, and tell Google to drop the access too (best effort). */
export async function removeGoogleConnection(dbx: DbOrTx, fetchImpl: typeof fetch = fetch): Promise<void> {
  const conn = await getGoogleConnection(dbx);
  if (!conn) return;
  try {
    await fetchImpl(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(decryptToken(conn.refreshTokenEnc))}`, { method: "POST" });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "google revoke failed");
  }
  await dbx.delete(googleConnections);
}

/** A fresh access token for the connected account. Records the error on the connection when Google refuses. */
export async function connectionAccessToken(dbx: DbOrTx, conn: GoogleConnection, fetchImpl: typeof fetch = fetch): Promise<{ token: string; expiresIn: number }> {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: decryptToken(conn.refreshTokenEnc),
      grant_type: "refresh_token",
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) {
    const error = json.error === "invalid_grant" ? "Google access was removed or expired. Reconnect Google Calendar." : `Google token error ${res.status}`;
    await dbx.update(googleConnections).set({ lastError: error }).where(eq(googleConnections.id, conn.id));
    throw new Error(error);
  }
  if (conn.lastError) await dbx.update(googleConnections).set({ lastError: null }).where(eq(googleConnections.id, conn.id));
  return { token: json.access_token, expiresIn: json.expires_in ?? 3600 };
}

export type CalendarChoice = { id: string; name: string; primary: boolean };

/** The connected account's calendars it can add events to, for each store's picker. */
export async function listWritableCalendars(dbx: DbOrTx, fetchImpl: typeof fetch = fetch): Promise<CalendarChoice[] | null> {
  const conn = await getGoogleConnection(dbx);
  if (!conn) return null;
  try {
    const { token } = await connectionAccessToken(dbx, conn, fetchImpl);
    const res = await fetchImpl(`${API}/users/me/calendarList?minAccessRole=writer&maxResults=250`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Google calendar list ${res.status}`);
    const json = (await res.json()) as { items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean }[] };
    return (json.items ?? [])
      .map((c) => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary }))
      .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "google calendar list failed");
    return null;
  }
}
