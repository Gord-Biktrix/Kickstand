import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { staffUsers } from "@/db/schema";
import { getStaffPhoto, hostNames, hostsFor, photoFromDataUrl, removeStaffPhoto, setStaffPhoto } from "@/lib/staff-photos";
import { resetDb, testDb } from "./helpers";

describe("staff photos and booking-page hosts", () => {
  let db: Db;
  beforeAll(async () => { db = await testDb(); });
  afterAll(async () => { await db.$client.end(); });
  beforeEach(async () => { await resetDb(db); });

  it("only takes a JPEG data URL of sensible size", () => {
    expect(photoFromDataUrl("data:image/jpeg;base64,QUJD")).toBe("QUJD");
    expect(() => photoFromDataUrl("data:image/svg+xml;base64,QUJD")).toThrow(/couldn't be read/);
    expect(() => photoFromDataUrl(`data:image/jpeg;base64,${"A".repeat(200_004)}`)).toThrow(/too large/);
  });

  it("lists hosts in the type's order, active only, first names, with photo links", async () => {
    const [a, b, c] = await db.insert(staffUsers).values([
      { email: "sam@biktrix.com", name: "Sam Rider", role: "staff" },
      { email: "pri@biktrix.com", name: "Priya K", role: "staff" },
      { email: "old@biktrix.com", name: "Old Timer", role: "staff", active: false },
    ]).returning();
    await setStaffPhoto(db, b.id, "QUJD");
    const hosts = await hostsFor(db, [b.id, a.id, c.id]);
    expect(hosts.map((h) => h.name)).toEqual(["Priya", "Sam"]);
    expect(hosts[0].photo).toMatch(new RegExp(`^/staff-photo/${b.id}\\?v=\\d+$`));
    expect(hosts[1].photo).toBeNull();
    expect(hostNames(hosts)).toBe("Priya and Sam");
    expect(hostNames([{ name: "A" }, { name: "B" }, { name: "C" }])).toBe("A, B and C");
    await removeStaffPhoto(db, b.id);
    expect(await getStaffPhoto(db, b.id)).toBeNull();
  });
});
