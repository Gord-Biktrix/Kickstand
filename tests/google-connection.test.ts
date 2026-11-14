import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { getCalendarWriter, setCalendarWriter } from "@/lib/google-calendar";
import { calendarAuthUrl, exchangeCalendarCode, getGoogleConnection, listWritableCalendars, removeGoogleConnection, saveGoogleConnection } from "@/lib/google-connection";
import { resetDb, testDb } from "./helpers";

process.env.GOOGLE_CLIENT_ID = "client-1";
process.env.GOOGLE_CLIENT_SECRET = "secret-1";
process.env.AUTH_ALLOWED_DOMAIN = "biktrix.com";

type Call = { url: string; body: string };
function fakeGoogle(routes: Record<string, (body: string) => { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? String(init.body) : "";
    calls.push({ url, body });
    const path = url.split("?")[0];
    const key = Object.keys(routes).find((k) => path === k);
    if (!key) return new Response("not found", { status: 404 });
    const r = routes[key](body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const claims = { aud: "client-1", iss: "https://accounts.google.com", email: "Bookings@biktrix.com", email_verified: "true", hd: "biktrix.com" };

describe("Connect Google Calendar", () => {
  let db: Db;
  beforeAll(async () => { db = await testDb(); });
  afterAll(async () => { setCalendarWriter(undefined); await db.$client.end(); });
  beforeEach(async () => { await resetDb(db); setCalendarWriter(undefined); });

  it("asks Google for offline calendar access", () => {
    const u = new URL(calendarAuthUrl("st8"));
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("scope")).toContain("calendar.events");
    expect(u.searchParams.get("prompt")).toContain("consent");
    expect(u.searchParams.get("redirect_uri")).toMatch(/\/auth\/google\/calendar\/callback$/);
    expect(u.searchParams.get("hd")).toBe("biktrix.com");
  });

  it("accepts a Biktrix account that granted calendar access, and refuses the rest", async () => {
    const ok = fakeGoogle({
      "https://oauth2.googleapis.com/token": () => ({ json: { id_token: "idt", refresh_token: "rt-1", scope: "openid email https://www.googleapis.com/auth/calendar.events" } }),
      "https://oauth2.googleapis.com/tokeninfo": () => ({ json: claims }),
    });
    expect(await exchangeCalendarCode("code", ok.fetchImpl)).toEqual({ ok: true, email: "bookings@biktrix.com", refreshToken: "rt-1", scope: "openid email https://www.googleapis.com/auth/calendar.events" });

    const noRefresh = fakeGoogle({ "https://oauth2.googleapis.com/token": () => ({ json: { id_token: "idt", scope: "calendar.events" } }) });
    expect(await exchangeCalendarCode("code", noRefresh.fetchImpl)).toMatchObject({ ok: false, reason: expect.stringMatching(/lasting access/) });

    const noScope = fakeGoogle({ "https://oauth2.googleapis.com/token": () => ({ json: { id_token: "idt", refresh_token: "rt", scope: "openid email" } }) });
    expect(await exchangeCalendarCode("code", noScope.fetchImpl)).toMatchObject({ ok: false, reason: expect.stringMatching(/Calendar access/) });

    const gmail = fakeGoogle({
      "https://oauth2.googleapis.com/token": () => ({ json: { id_token: "idt", refresh_token: "rt", scope: "calendar.events" } }),
      "https://oauth2.googleapis.com/tokeninfo": () => ({ json: { ...claims, email: "x@gmail.com", hd: undefined } }),
    });
    expect(await exchangeCalendarCode("code", gmail.fetchImpl)).toMatchObject({ ok: false, reason: "Use a Biktrix Google account." });
  });

  it("stores one connection with the token encrypted, lists its calendars, and disconnects", async () => {
    await saveGoogleConnection(db, { email: "old@biktrix.com", refreshToken: "rt-old", scope: "s", connectedBy: "u1" });
    await saveGoogleConnection(db, { email: "bookings@biktrix.com", refreshToken: "rt-1", scope: "s", connectedBy: "u1" });
    const conn = await getGoogleConnection(db);
    expect(conn?.email).toBe("bookings@biktrix.com");
    expect(conn?.refreshTokenEnc).not.toContain("rt-1");

    const g = fakeGoogle({
      "https://oauth2.googleapis.com/token": (body) => ({ json: body.includes("refresh_token=rt-1") ? { access_token: "at-1", expires_in: 3600 } : { error: "invalid_grant" }, status: body.includes("refresh_token=rt-1") ? 200 : 400 }),
      "https://www.googleapis.com/calendar/v3/users/me/calendarList": () => ({ json: { items: [{ id: "sales@group.calendar.google.com", summary: "Sales Calendar" }, { id: "bookings@biktrix.com", summary: "bookings@biktrix.com", primary: true }] } }),
      "https://oauth2.googleapis.com/revoke": () => ({ json: {} }),
    });
    expect(await listWritableCalendars(db, g.fetchImpl)).toEqual([
      { id: "bookings@biktrix.com", name: "bookings@biktrix.com", primary: true },
      { id: "sales@group.calendar.google.com", name: "Sales Calendar", primary: false },
    ]);

    // Calendar writes now go through the connected account.
    expect(await getCalendarWriter(db)).not.toBeNull();

    await removeGoogleConnection(db, g.fetchImpl);
    expect(g.calls.some((c) => c.url.startsWith("https://oauth2.googleapis.com/revoke"))).toBe(true);
    expect(await getGoogleConnection(db)).toBeNull();
  });

  it("records a revoked or expired grant so Settings can say to reconnect", async () => {
    await saveGoogleConnection(db, { email: "bookings@biktrix.com", refreshToken: "rt-dead", scope: "s", connectedBy: "u1" });
    const g = fakeGoogle({ "https://oauth2.googleapis.com/token": () => ({ status: 400, json: { error: "invalid_grant" } }) });
    expect(await listWritableCalendars(db, g.fetchImpl)).toBeNull();
    expect((await getGoogleConnection(db))?.lastError).toMatch(/Reconnect Google Calendar/);
  });
});
