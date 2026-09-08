import type { Role } from "@/db/schema";

/**
 * owner = "Super admin": one person (Gord) above every admin. Admins run the stores and manage staff and
 * managers; only the owner can create, demote, deactivate or delete admins, and nobody can touch the owner.
 */
export const ROLE_RANK: Record<Role, number> = { staff: 0, manager: 1, admin: 2, owner: 3 };
export const ROLES: Role[] = ["staff", "manager", "admin", "owner"];
export const ROLE_LABEL: Record<Role, string> = { staff: "Staff", manager: "Manager", admin: "Admin", owner: "Super admin" };

export function isRole(value: string): value is Role {
  return (ROLES as string[]).includes(value);
}

function rank(role: string): number {
  return ROLE_RANK[role as Role] ?? -1;
}

export function roleLabel(role: string): string {
  return isRole(role) ? ROLE_LABEL[role] : role;
}

export function hasRole(role: string, min: Role): boolean {
  return rank(role) >= ROLE_RANK[min];
}

/** Roles this actor may hand out: everything strictly below their own. Nobody assigns owner from the UI. */
export function assignableRoles(actor: string): Role[] {
  return ROLES.filter((r) => r !== "owner" && ROLE_RANK[r] < rank(actor));
}

/** May `actor` change, deactivate or delete an account with role `target`? Only from strictly above. */
export function canManage(actor: string, target: string): boolean {
  return rank(actor) > rank(target);
}
