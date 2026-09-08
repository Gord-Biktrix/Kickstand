import { and, eq, gt, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { magicLinks, staffSessions, staffUsers, type Role, type StaffUser } from "@/db/schema";
import { logger } from "./logger";
import { sendInviteEmail, sendMagicLinkEmail } from "./mailer";
import { baseUrl } from "./messages";
import { hasRole } from "./roles";
import { hashPassword, passwordProblem, verifyPassword } from "./passwords";
import { generateToken, hashToken } from "./tokens";

export const SESSION_COOKIE = "pickup_session";
const SESSION_DAYS = 30;
const MAGIC_LINK_MINUTES = 15;
const INVITE_LINK_DAYS = 7;

export { assignableRoles, canManage, hasRole, isRole, ROLE_LABEL, ROLE_RANK, roleLabel, ROLES } from "./roles";
export type { Role };

export class AuthorizationError extends Error {
  constructor(message = "Not allowed") {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * Who may receive a sign-in link. The domain rule always applies. AUTH_ALLOWED_EMAILS is a bootstrap
 * list for the first accounts; anyone with an active staff row (added via Settings › Staff or
 * staff:add) is allowed regardless of that list.
 */
export function emailAllowed(email: string, hasStaffRow = false): boolean {
  const domain = (process.env.AUTH_ALLOWED_DOMAIN ?? "").toLowerCase();
  const list = (process.env.AUTH_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const lower = email.toLowerCase();
  if (domain && !lower.endsWith(`@${domain}`)) return false;
  if (!hasStaffRow && list.length > 0 && !list.includes(lower)) return false;
  return true;
}

export async function requestMagicLink(
  rawEmail: string,
): Promise<{ ok: true; devLink?: string } | { ok: false; error: string }> {
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "Enter a valid email." };
  const [user] = await db
    .select()
    .from(staffUsers)
    .where(and(eq(staffUsers.email, email), eq(staffUsers.active, true)))
    .limit(1);
  if (!user || !emailAllowed(email, true)) {
    // Same response as success so the login form can't be used to enumerate staff.
    logger.info({ emailDomain: email.split("@")[1] }, "magic link refused");
    return { ok: true };
  }
  const token = generateToken();
  await db.insert(magicLinks).values({
    email,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + MAGIC_LINK_MINUTES * 60_000),
  });
  const link = `${baseUrl()}/auth/verify?token=${token}`;
  await sendMagicLinkEmail(email, link);
  const showLink =
    process.env.NODE_ENV !== "production" && process.env.AUTH_DEV_SHOW_LINK === "true";
  return { ok: true, devLink: showLink ? link : undefined };
}

/** Exchange a magic-link token for a session token. Returns null when invalid/expired/used. */
export async function consumeMagicLink(token: string): Promise<string | null> {
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [link] = await tx
      .update(magicLinks)
      .set({ usedAt: now })
      .where(
        and(
          eq(magicLinks.tokenHash, hashToken(token)),
          isNull(magicLinks.usedAt),
          gt(magicLinks.expiresAt, now),
        ),
      )
      .returning();
    if (!link) return null;
    const [user] = await tx
      .select()
      .from(staffUsers)
      .where(and(eq(staffUsers.email, link.email), eq(staffUsers.active, true)))
      .limit(1);
    if (!user) return null;
    return createSession(tx, user.id, now);
  });
  return result;
}

async function createSession(tx: Pick<typeof db, "insert">, staffUserId: string, now = new Date()): Promise<string> {
  const sessionToken = generateToken();
  await tx.insert(staffSessions).values({
    staffUserId,
    tokenHash: hashToken(sessionToken),
    expiresAt: new Date(now.getTime() + SESSION_DAYS * 86_400_000),
  });
  return sessionToken;
}

/**
 * Sign in an already-verified identity (Google). Only an active staff row gets a session; the domain rule
 * applies too. Returns the session token or null when the person is not on the staff list.
 */
export async function createSessionForEmail(rawEmail: string): Promise<string | null> {
  const email = rawEmail.trim().toLowerCase();
  if (!emailAllowed(email, true)) return null;
  const [user] = await db
    .select()
    .from(staffUsers)
    .where(and(eq(staffUsers.email, email), eq(staffUsers.active, true)))
    .limit(1);
  if (!user) return null;
  return createSession(db, user.id);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  };
}

export async function getCurrentUser(): Promise<StaffUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const [row] = await db
    .select({ user: staffUsers })
    .from(staffSessions)
    .innerJoin(staffUsers, eq(staffSessions.staffUserId, staffUsers.id))
    .where(
      and(
        eq(staffSessions.tokenHash, hashToken(token)),
        gt(staffSessions.expiresAt, new Date()),
        eq(staffUsers.active, true),
      ),
    )
    .limit(1);
  return row?.user ?? null;
}

/** For pages: redirect to login when signed out, to /app when the role is too low. */
export async function requireUser(min: Role = "staff"): Promise<StaffUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!hasRole(user.role, min)) redirect("/app?denied=1");
  return user;
}

/** For server actions: every mutation re-checks the role on the server. */
export async function requireActor(min: Role = "staff"): Promise<StaffUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthorizationError("Sign in required");
  if (!hasRole(user.role, min)) throw new AuthorizationError(`Requires ${min} role`);
  return user;
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await db.delete(staffSessions).where(eq(staffSessions.tokenHash, hashToken(token)));
  }
  jar.delete(SESSION_COOKIE);
}

export type StaffInvite = { email: string; name: string; role: Role; showroomId: string | null };

/**
 * Add (or re-activate / update) a staff account and email an invitation with a sign-in link that
 * stays valid for a week. Idempotent: inviting an existing address updates name/role/store and sends a
 * fresh link. Only admins may create admins (enforced by the caller).
 */
export async function inviteStaff(
  invite: StaffInvite,
  by: { name: string; showroomName: string },
  opts: { sendEmail?: boolean } = {},
): Promise<{ user: StaffUser; link: string | null }> {
  const email = invite.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter a valid email address.");
  if (!emailAllowed(email, true)) throw new Error(`Only ${process.env.AUTH_ALLOWED_DOMAIN ?? "company"} addresses can be invited.`);
  const name = invite.name.trim() || email.split("@")[0];
  const [user] = await db
    .insert(staffUsers)
    .values({ email, name, role: invite.role, showroomId: invite.showroomId, active: true })
    .onConflictDoUpdate({ target: staffUsers.email, set: { name, role: invite.role, showroomId: invite.showroomId, active: true } })
    .returning();
  // With Google sign-in the person just signs in; there is nothing to email.
  if (opts.sendEmail === false) return { user, link: null };
  const token = generateToken();
  await db.insert(magicLinks).values({ email, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_LINK_DAYS * 86_400_000) });
  const link = `${baseUrl()}/auth/verify?token=${token}`;
  await sendInviteEmail(email, { name, inviter: by.name, showroom: by.showroomName, link });
  return { user, link };
}

export async function listStaff(): Promise<StaffUser[]> {
  return db.select().from(staffUsers).orderBy(staffUsers.active, staffUsers.name);
}

export async function setStaffActive(id: string, active: boolean): Promise<void> {
  await db.update(staffUsers).set({ active }).where(eq(staffUsers.id, id));
  // Signing someone out everywhere is the point of deactivating.
  if (!active) await db.delete(staffSessions).where(eq(staffSessions.staffUserId, id));
}

export async function updateStaff(id: string, patch: { name?: string; role?: Role; showroomId?: string | null }): Promise<void> {
  await db.update(staffUsers).set(patch).where(eq(staffUsers.id, id));
}

/** Remove an account outright: sessions, pending links, then the row. Timeline entries keep the name they recorded. */
export async function deleteStaff(id: string): Promise<void> {
  const [user] = await db.select().from(staffUsers).where(eq(staffUsers.id, id));
  if (!user) return;
  await db.delete(staffSessions).where(eq(staffSessions.staffUserId, id));
  await db.delete(magicLinks).where(eq(magicLinks.email, user.email));
  await db.delete(staffUsers).where(eq(staffUsers.id, id));
}

const PASSWORD_MAX_FAILURES = 5;
const PASSWORD_LOCK_MINUTES = 15;

/**
 * Email + password sign-in. Same "invalid" answer for unknown email, no password set, wrong password or
 * deactivated account, so the form can't enumerate staff. Five misses lock the password for 15 minutes
 * (Google and the emailed link keep working — the lock only covers the password path).
 */
export async function signInWithPassword(
  rawEmail: string,
  password: string,
): Promise<{ ok: true; session: string } | { ok: false; error: "invalid" | "locked" }> {
  const email = rawEmail.trim().toLowerCase();
  const [user] = await db.select().from(staffUsers).where(and(eq(staffUsers.email, email), eq(staffUsers.active, true))).limit(1);
  if (!user || !user.passwordHash || !emailAllowed(email, true)) {
    logger.info({ emailDomain: email.split("@")[1] }, "password sign-in refused");
    return { ok: false, error: "invalid" };
  }
  const now = new Date();
  if (user.passwordLockedUntil && user.passwordLockedUntil > now) return { ok: false, error: "locked" };
  if (!verifyPassword(password, user.passwordHash)) {
    const failed = user.passwordFailed + 1;
    await db
      .update(staffUsers)
      .set({
        passwordFailed: failed,
        passwordLockedUntil: failed >= PASSWORD_MAX_FAILURES ? new Date(now.getTime() + PASSWORD_LOCK_MINUTES * 60_000) : null,
      })
      .where(eq(staffUsers.id, user.id));
    return { ok: false, error: failed >= PASSWORD_MAX_FAILURES ? "locked" : "invalid" };
  }
  if (user.passwordFailed || user.passwordLockedUntil) {
    await db.update(staffUsers).set({ passwordFailed: 0, passwordLockedUntil: null }).where(eq(staffUsers.id, user.id));
  }
  return { ok: true, session: await createSession(db, user.id, now) };
}

/** A signed-in person sets (or replaces) their own password. The live session is the proof of identity. */
export async function setPassword(user: StaffUser, password: string): Promise<void> {
  const problem = passwordProblem(password, user.email);
  if (problem) throw new Error(problem);
  await db
    .update(staffUsers)
    .set({ passwordHash: hashPassword(password), passwordFailed: 0, passwordLockedUntil: null })
    .where(eq(staffUsers.id, user.id));
}

/** Remove a password (own account, or an admin resetting someone's). They sign in with Google or a link and set a new one. */
export async function clearPassword(id: string): Promise<void> {
  await db.update(staffUsers).set({ passwordHash: null, passwordFailed: 0, passwordLockedUntil: null }).where(eq(staffUsers.id, id));
}
