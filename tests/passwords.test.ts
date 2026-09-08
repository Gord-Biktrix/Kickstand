import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { staffUsers } from "@/db/schema";
import { clearPassword, inviteStaff, setPassword, signInWithPassword } from "@/lib/auth";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/passwords";
import { resetDb, testDb } from "./helpers";

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(async () => { await db.$client.end(); });
beforeEach(async () => { await resetDb(db); });

describe("passwords", () => {
  it("hashes with a fresh salt and verifies", () => {
    const a = hashPassword("correct horse battery");
    const b = hashPassword("correct horse battery");
    expect(a).not.toBe(b);
    expect(verifyPassword("correct horse battery", a)).toBe(true);
    expect(verifyPassword("correct horse batterx", a)).toBe(false);
    expect(verifyPassword("anything", null)).toBe(false);
    expect(passwordProblem("short", "sam@biktrix.com")).toMatch(/at least 10/);
    expect(passwordProblem("sam.lee-rocks-2026", "sam.lee@biktrix.com")).toMatch(/email/);
    expect(passwordProblem("purple kettle sings", "sam@biktrix.com")).toBeNull();
  });

  it("signs in, locks after five misses, and unlocks by reset", async () => {
    process.env.AUTH_ALLOWED_DOMAIN = "biktrix.com";
    const { user } = await inviteStaff({ email: "sam@biktrix.com", name: "Sam", role: "staff", showroomId: null }, { name: "Gordon", showroomName: "Vancouver" }, { sendEmail: false });
    expect(await signInWithPassword("sam@biktrix.com", "purple kettle sings")).toEqual({ ok: false, error: "invalid" }); // none set yet
    await expect(setPassword(user, "short")).rejects.toThrow(/at least 10/);
    await setPassword(user, "purple kettle sings");
    const ok = await signInWithPassword("Sam@Biktrix.com", "purple kettle sings");
    expect(ok.ok).toBe(true);
    for (let i = 0; i < 4; i++) expect(await signInWithPassword("sam@biktrix.com", "nope nope nope")).toEqual({ ok: false, error: "invalid" });
    expect(await signInWithPassword("sam@biktrix.com", "nope nope nope")).toEqual({ ok: false, error: "locked" });
    expect(await signInWithPassword("sam@biktrix.com", "purple kettle sings")).toEqual({ ok: false, error: "locked" }); // right password, still locked
    await clearPassword(user.id);
    const [row] = await db.select().from(staffUsers).where(eq(staffUsers.id, user.id));
    expect(row.passwordHash).toBeNull();
    expect(row.passwordLockedUntil).toBeNull();
    // Unknown address answers exactly like a wrong password.
    expect(await signInWithPassword("nobody@biktrix.com", "purple kettle sings")).toEqual({ ok: false, error: "invalid" });
  });
});
