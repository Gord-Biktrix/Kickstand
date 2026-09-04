import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { customerKey, customerOrders, customerProfile, groupOrders, normalizePhone, parseCustomerKey, searchCustomers } from "@/lib/customers";
import type { ShowroomCtx } from "@/lib/showroom";
import { makeOrder, makeUnit, resetDb, testDb } from "./helpers";

describe("customer identity (pure)", () => {
  it("normalises phones to national digits", () => {
    expect(normalizePhone("+1 (604) 555-0100")).toBe("6045550100");
    expect(normalizePhone("604.555.0100")).toBe("6045550100");
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it("prefers the Lightspeed id, then phone, then email, then name", () => {
    const base = { lsCustomerId: null, customerPhone: null, customerEmail: null, customerName: "Jo Rider" };
    expect(customerKey({ ...base, lsCustomerId: "9020", customerPhone: "6045550100" })).toBe("ls:9020");
    expect(customerKey({ ...base, customerPhone: "(604) 555-0100", customerEmail: "jo@x.ca" })).toBe("ph:6045550100");
    expect(customerKey({ ...base, customerEmail: "Jo@X.ca" })).toBe("em:jo@x.ca");
    expect(customerKey(base)).toBe("nm:jo rider");
    expect(parseCustomerKey("ls:9020")).toEqual({ kind: "ls", value: "9020" });
    expect(parseCustomerKey("bogus")).toBeNull();
  });

  it("groups a Lightspeed order with an older manual order that shares the phone", () => {
    const a = { lsCustomerId: "9020", customerPhone: "+16045550100", customerEmail: null, customerName: "Test Test" };
    const b = { lsCustomerId: null, customerPhone: "604-555-0100", customerEmail: "t@x.ca", customerName: "T. Test" };
    const c = { lsCustomerId: null, customerPhone: null, customerEmail: "t@x.ca", customerName: "Other" };
    const d = { lsCustomerId: "1", customerPhone: "+16045550199", customerEmail: null, customerName: "Someone Else" };
    const groups = groupOrders([a, d, c, b]); // c and b share an email; b and a share a phone → one group
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.includes(a))).toEqual(expect.arrayContaining([a, b, c]));
  });
});

describe("customer search and profile (db)", () => {
  let db: Db;
  let showroom: ShowroomCtx;
  beforeAll(async () => { db = await testDb(); });
  afterAll(async () => { await db.$client.end(); });
  beforeEach(async () => { showroom = await resetDb(db); });

  it("finds a customer by any identifier and shows every bike, including past ones", async () => {
    const ls = await makeOrder(db, showroom, { customerName: "Test Test", customerPhone: "+16045550100", lsCustomerId: "9020", source: "lightspeed", orderRef: "44414" });
    const manual = await makeOrder(db, showroom, { customerName: "Test Test", customerPhone: "604 555 0100", customerEmail: null, orderRef: "M-1", model: "Stunner Go" });
    const other = await makeOrder(db, showroom, { customerName: "Sam Other", customerPhone: "+16045550199", customerEmail: "sam@x.ca", orderRef: "M-2" });
    const u1 = await makeUnit(db, showroom, ls.id, { boxTag: "B-1" });
    await makeUnit(db, showroom, manual.id, { boxTag: "B-2", status: "picked_up", pickedUpAt: new Date() });
    await makeUnit(db, showroom, other.id, { boxTag: "B-3" });

    const byName = await searchCustomers(db, showroom, "test test");
    expect(byName).toHaveLength(1);
    expect(byName[0].key).toBe("ls:9020");
    expect(byName[0].orders.map((o) => o.orderRef).sort()).toEqual(["44414", "M-1"]);
    expect(byName[0].units).toHaveLength(2);

    expect((await searchCustomers(db, showroom, "555-0100"))[0]?.key).toBe("ls:9020");
    expect((await searchCustomers(db, showroom, "B-3"))[0]?.name).toBe("Sam Other");
    expect(await searchCustomers(db, showroom, "nobody")).toEqual([]);

    const viaPhone = await customerOrders(db, showroom, "ph:6045550100");
    expect(viaPhone.map((o) => o.id).sort()).toEqual([ls.id, manual.id].sort());

    const profile = await customerProfile(db, showroom, "ls:9020");
    expect(profile?.name).toBe("Test Test");
    expect(profile?.lsCustomerId).toBe("9020");
    expect(profile?.bikes.map((b) => b.unit.boxTag).sort()).toEqual(["B-1", "B-2"]);
    expect(profile?.bikes.find((b) => b.unit.id === u1.id)?.order.orderRef).toBe("44414");
    expect(await customerProfile(db, showroom, "ls:nope")).toBeNull();
  });
});
