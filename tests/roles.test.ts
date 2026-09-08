import { describe, expect, it } from "vitest";
import { assignableRoles, canManage, hasRole } from "@/lib/roles";

describe("roles", () => {
  it("owner (super admin) sits above admin and passes every admin gate", () => {
    expect(hasRole("owner", "admin")).toBe(true);
    expect(hasRole("admin", "owner")).toBe(false);
  });
  it("people may only hand out and manage roles strictly below their own", () => {
    expect(assignableRoles("owner")).toEqual(["staff", "manager", "admin"]);
    expect(assignableRoles("admin")).toEqual(["staff", "manager"]);
    expect(assignableRoles("manager")).toEqual(["staff"]);
    expect(canManage("owner", "admin")).toBe(true);
    expect(canManage("admin", "admin")).toBe(false);
    expect(canManage("admin", "owner")).toBe(false);
    expect(canManage("admin", "manager")).toBe(true);
  });
});
