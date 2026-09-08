import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

/** scrypt (N=2^15, r=8, p=1) via Node's crypto — no dependency. Stored as `scrypt$<salt b64url>$<hash b64url>`. */
const N = 2 ** 15;
const KEYLEN = 64;
export const MIN_PASSWORD_LENGTH = 10;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFKC"), salt, KEYLEN, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64url");
  const actual = scryptSync(password.normalize("NFKC"), Buffer.from(saltB64, "base64url"), expected.length, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Cheap sanity rules; length is what matters. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 200) return "That password is too long.";
  const local = email.split("@")[0].toLowerCase();
  if (local.length >= 4 && password.toLowerCase().includes(local)) return "Don't use your email address in the password.";
  if (/^(.)\1+$/.test(password) || /^(0123456789|1234567890|password|qwertyuiop)/i.test(password)) return "That password is too easy to guess.";
  return null;
}
