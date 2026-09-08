/**
 * Sign in with Google (OpenID Connect, authorization-code flow, no library). Only Workspace accounts on
 * AUTH_ALLOWED_DOMAIN that also have an active staff row get a session — see createSessionForEmail.
 */
import { baseUrl } from "./messages";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TOKENINFO_ENDPOINT = "https://oauth2.googleapis.com/tokeninfo";

export function googleEnabled(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
}

export function googleRedirectUri(): string {
  return `${baseUrl()}/auth/google/callback`;
}

export function googleAuthUrl(state: string): string {
  const u = new URL(AUTH_ENDPOINT);
  u.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID ?? "");
  u.searchParams.set("redirect_uri", googleRedirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  u.searchParams.set("prompt", "select_account");
  const domain = process.env.AUTH_ALLOWED_DOMAIN;
  if (domain) u.searchParams.set("hd", domain); // Google pre-filters the account chooser to the Workspace domain
  return u.toString();
}

export type GoogleClaims = {
  aud?: string;
  iss?: string;
  email?: string;
  email_verified?: string | boolean;
  hd?: string;
  name?: string;
  exp?: string | number;
};

/** Pure check of the ID-token claims. `hd` is Google's authoritative Workspace domain — the email suffix alone is not. */
export function checkGoogleClaims(
  claims: GoogleClaims,
  opts: { clientId: string; domain: string; now?: number },
): { ok: true; email: string; name: string } | { ok: false; reason: "token" | "domain" } {
  const now = opts.now ?? Date.now() / 1000;
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (claims.aud !== opts.clientId || !claims.email || !verified) return { ok: false, reason: "token" };
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") return { ok: false, reason: "token" };
  if (claims.exp !== undefined && Number(claims.exp) < now) return { ok: false, reason: "token" };
  const email = claims.email.toLowerCase();
  if (opts.domain && (claims.hd ?? "").toLowerCase() !== opts.domain.toLowerCase()) return { ok: false, reason: "domain" };
  return { ok: true, email, name: claims.name?.trim() || email.split("@")[0] };
}

/** Exchange the code, then let Google validate the ID token's signature for us (tokeninfo) and check the claims. */
export async function exchangeGoogleCode(
  code: string,
): Promise<{ ok: true; email: string; name: string } | { ok: false; reason: "token" | "domain" }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) return { ok: false, reason: "token" };
  const { id_token } = (await res.json()) as { id_token?: string };
  if (!id_token) return { ok: false, reason: "token" };
  const info = await fetch(`${TOKENINFO_ENDPOINT}?id_token=${encodeURIComponent(id_token)}`);
  if (!info.ok) return { ok: false, reason: "token" };
  const claims = (await info.json()) as GoogleClaims;
  return checkGoogleClaims(claims, { clientId: process.env.GOOGLE_CLIENT_ID ?? "", domain: process.env.AUTH_ALLOWED_DOMAIN ?? "" });
}
