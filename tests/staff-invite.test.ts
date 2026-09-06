import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { magicLinks, staffUsers } from "@/db/schema";
import { consumeMagicLink, emailAllowed, inviteStaff, setStaffActive } from "@/lib/auth";
import { resetDb, testDb } from "./helpers";

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.$client.end(); });
beforeEach(async () => { await resetDb(db); });

describe("staff invitations", () => {
  it("creates the account, issues a week-long link that signs them in, and deactivation revokes it", async () => {
    process.env.AUTH_ALLOWED_DOMAIN = "biktrix.com";
    process.env.AUTH_ALLOWED_EMAILS = "gord@biktrix.com"; // bootstrap list must not block invited people
    expect(emailAllowed("sam@biktrix.com")).toBe(false);
    expect(emailAllowed("sam@biktrix.com", true)).toBe(true);
    expect(emailAllowed("sam@gmail.com", true)).toBe(false);

    const { user, link } = await inviteStaff({ email: "Sam@Biktrix.com", name: "Sam Lee", role: "staff", showroomId: null }, { name: "Gordon", showroomName: "Biktrix Vancouver" });
    expect(user).toMatchObject({ email: "sam@biktrix.com", name: "Sam Lee", role: "staff", active: true });
    const token = new URL(link).searchParams.get("token")!;
    const [ml] = await db.select().from(magicLinks).where(eq(magicLinks.email, "sam@biktrix.com"));
    expect(ml.expiresAt.getTime() - Date.now()).toBeGreaterThan(6 * 86_400_000);
    const session = await consumeMagicLink(token);
    expect(session).toBeTruthy();

    // Re-inviting updates role and sends a fresh link; deactivating blocks sign-in.
    const again = await inviteStaff({ email: "sam@biktrix.com", name: "Sam Lee", role: "manager", showroomId: null }, { name: "Gordon", showroomName: "Biktrix Vancouver" });
    expect(again.user.role).toBe("manager");
    await setStaffActive(user.id, false);
    const [row] = await db.select().from(staffUsers).where(eq(staffUsers.id, user.id));
    expect(row.active).toBe(false);
    expect(await consumeMagicLink(new URL(again.link).searchParams.get("token")!)).toBeNull();
  });
});
