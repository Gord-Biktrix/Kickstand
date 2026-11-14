/**
 * Copy bookings onto each profile's Google Calendar, so the store's calendar shows every booking without
 * anyone typing it in. Two ways to write, first match wins:
 *  1. The Google account connected in Settings › Stores (src/lib/google-connection.ts), like BookIt did; each
 *     store picks one of that account's calendars.
 *  2. A Google service account (GOOGLE_SERVICE_ACCOUNT_JSON); each store's calendar is shared with its email.
 * No library: plain HTTP. Kickstand stays the master copy: events are written, never read back.
 */
import { createSign } from "node:crypto";
import type { DbOrTx } from "@/db/client";
import { connectionAccessToken, getGoogleConnection } from "./google-connection";
import { logger } from "./logger";

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };
export type CalendarEvent = { summary: string; description: string; location: string; start: Date; end: Date; timeZone: string };

export interface CalendarWriter {
  upsert(calendarId: string, eventId: string | null, event: CalendarEvent): Promise<string>;
  remove(calendarId: string, eventId: string): Promise<void>;
}

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3";

function serviceAccount(): ServiceAccount | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw) as ServiceAccount;
    return sa.client_email && sa.private_key ? sa : null;
  } catch {
    logger.warn("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
    return null;
  }
}

/** The email to share store calendars with, or null when no service account is configured. */
export function calendarServiceEmail(): string | null {
  return serviceAccount()?.client_email ?? null;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

export function signedAssertion(sa: ServiceAccount, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? "https://oauth2.googleapis.com/token", iat: nowSec, exp: nowSec + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
}

/** Fetches a fresh access token: { token, expiresIn seconds }. */
export type TokenSource = () => Promise<{ token: string; expiresIn: number }>;

function serviceAccountTokens(sa: ServiceAccount, fetchImpl: typeof fetch): TokenSource {
  return async () => {
    const res = await fetchImpl(sa.token_uri ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedAssertion(sa) }),
    });
    if (!res.ok) throw new Error(`Google token ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    return { token: json.access_token, expiresIn: json.expires_in };
  };
}

export class GoogleCalendarWriter implements CalendarWriter {
  private token: { value: string; expiresAt: number } | null = null;
  private tokens: TokenSource;
  constructor(auth: ServiceAccount | TokenSource, private fetchImpl: typeof fetch = fetch) {
    this.tokens = typeof auth === "function" ? auth : serviceAccountTokens(auth, fetchImpl);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const { token, expiresIn } = await this.tokens();
    this.token = { value: token, expiresAt: Date.now() + expiresIn * 1000 };
    return token;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204 || (method === "DELETE" && res.status === 410)) return {};
    const text = await res.text();
    if (!res.ok) throw new Error(`Google Calendar ${method} ${res.status}${res.status === 404 ? " (calendar not found: wrong calendar, or not shared with the account writing to it)" : ""}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  async upsert(calendarId: string, eventId: string | null, e: CalendarEvent): Promise<string> {
    const body = {
      summary: e.summary,
      description: e.description,
      location: e.location,
      start: { dateTime: e.start.toISOString(), timeZone: e.timeZone },
      end: { dateTime: e.end.toISOString(), timeZone: e.timeZone },
    };
    const cal = encodeURIComponent(calendarId);
    const res = eventId ? await this.call("PATCH", `/calendars/${cal}/events/${encodeURIComponent(eventId)}`, body) : await this.call("POST", `/calendars/${cal}/events`, body);
    return String(res.id ?? eventId);
  }

  async remove(calendarId: string, eventId: string): Promise<void> {
    await this.call("DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  }
}

let override: CalendarWriter | null | undefined;

/** Tests swap in a fake; null = calendar copying off. */
export function setCalendarWriter(w: CalendarWriter | null | undefined) {
  override = w;
}

export async function getCalendarWriter(dbx: DbOrTx): Promise<CalendarWriter | null> {
  if (override !== undefined) return override;
  const conn = await getGoogleConnection(dbx);
  if (conn) return new GoogleCalendarWriter(() => connectionAccessToken(dbx, conn));
  const sa = serviceAccount();
  return sa ? new GoogleCalendarWriter(sa) : null;
}
