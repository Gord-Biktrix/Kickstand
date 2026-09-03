import type { Role } from "@/db/schema";

export const ROLE_RANK: Record<Role, number> = { staff: 0, manager: 1, admin: 2 };

export function hasRole(role: string, min: Role): boolean {
  return (ROLE_RANK[role as Role] ?? -1) >= ROLE_RANK[min];
}
