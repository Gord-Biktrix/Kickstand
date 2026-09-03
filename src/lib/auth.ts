import { and, eq, gt, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { magicLinks, staffSessions, staffUsers, type Role, type StaffUser } from "@/db/schema";
import { logger } from "./logger";
import { sendMagicLinkEmail } from "./mailer";
import { baseUrl } from "./messages";
import { hasRole } from "./roles";
import { generateToken, hashToken } from "./tokens";

export const SESSION_COOKIE = "pickup_session";
const SESSION_DAYS = 30;
const MAGIC_LINK_MINUTES = 15;

export { hasRole, ROLE_RANK } from "./roles";

export class AuthorizationError extends Error {
  constructor(message = "Not allowed") {
    super(message);
    this.name = "AuthorizationError";
  }
}

function emailAllowed(email: string): boolean {
  const domain = (process.env.AUTH_ALLOWED_DOMAIN ?? "").toLowerCase();
  const list = (process.env.AUTH_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const lower = email.toLowerCase();
  if (domain && !lower.endsWith(`@${domain}`)) return false;
  if (list.length > 0 && !list.includes(lower)) return false;
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
  if (!emailAllowed(email) || !user) {
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
    const sessionToken = generateToken();
    await tx.insert(staffSessions).values({
      staffUserId: user.id,
      tokenHash: hashToken(sessionToken),
      expiresAt: new Date(now.getTime() + SESSION_DAYS * 86_400_000),
    });
    return sessionToken;
  });
  return result;
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
