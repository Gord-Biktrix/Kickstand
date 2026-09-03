import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function key(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return createHash("sha256").update(secret).digest();
}

/**
 * Customer links must be re-sendable (nudges, hold-ending, staff copy button), so the
 * token is stored encrypted next to its lookup hash. AES-256-GCM, key derived from AUTH_SECRET.
 */
export function encryptToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

export function decryptToken(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
