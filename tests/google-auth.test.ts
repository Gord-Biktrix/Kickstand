import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { createSessionForEmail, inviteStaff, setStaffActive } from "@/lib/auth";
import { checkGoogleClaims, googleAuthUrl } from "@/lib/google-auth";
import { resetDb, testDb } from "./helpers";

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.$client.end(); });
beforeEach(async () => { await resetDb(db); });

describe("Sign in with Google", () => {
  it("accepts only verified Workspace tokens for our client", () => {
    const good = { aud: "cid", iss: "https://accounts.google.com", email: "Sam@Biktrix.com", email_verified: "true", hd: "biktrix.com", name: "Sam Lee", exp: "9999999999" };
    expect(checkGoogleClaims(good, { clientId: "cid", domain: "biktrix.com" })).toEqual({ ok: true, email: "sam@biktrix.com", name: "Sam Lee" });
    expect(checkGoogleClaims({ ...good, aud: "other" }, { clientId: "cid", domain: "biktrix.com" })).toEqual({ ok: false, reason: "token" });
    expect(checkGoogleClaims({ ...good, email_verified: "false" }, { clientId: "cid", domain: "biktrix.com" })).toEqual({ ok: false, reason: "token" });
    expect(checkGoogleClaims({ ...good, exp: "1" }, { clientId: "cid", domain: "biktrix.com" })).toEqual({ ok: false, reason: "token" });
    // A gmail.com account that merely *contains* the domain, or no hd claim at all, is refused.
    expect(checkGoogleClaims({ ...good, hd: undefined, email: "sam.biktrix.com@gmail.com" }, { clientId: "cid", domain: "biktrix.com" })).toEqual({ ok: false, reason: "domain" });
  });

  it("builds the Google URL with our redirect and the domain hint", () => {
    process.env.GOOGLE_CLIENT_ID = "cid";
    process.env.AUTH_ALLOWED_DOMAIN = "biktrix.com";
    process.env.APP_BASE_URL = "https://kickstand.example";
    const u = new URL(googleAuthUrl("st4te"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("redirect_uri")).toBe("https://kickstand.example/auth/google/callback");
    expect(u.searchParams.get("state")).toBe("st4te");
    expect(u.searchParams.get("hd")).toBe("biktrix.com");
    expect(u.searchParams.get("scope")).toContain("email");
  });

  it("only people on the staff list get a session; deactivated ones don't", async () => {
    process.env.AUTH_ALLOWED_DOMAIN = "biktrix.com";
    process.env.AUTH_ALLOWED_EMAILS = "gord@biktrix.com";
    expect(await createSessionForEmail("stranger@biktrix.com")).toBeNull();
    const { user, link } = await inviteStaff({ email: "sam@biktrix.com", name: "Sam", role: "staff", showroomId: null }, { name: "Gordon", showroomName: "Vancouver" }, { sendEmail: false });
    expect(link).toBeNull();
    expect(await createSessionForEmail("Sam@biktrix.com")).toBeTruthy();
    await setStaffActive(user.id, false);
    expect(await createSessionForEmail("sam@biktrix.com")).toBeNull();
  });
});
