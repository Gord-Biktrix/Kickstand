import { logger } from "./logger";

/** Staff magic-link email. Resend when configured, console otherwise. */
export async function sendMagicLinkEmail(to: string, link: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.info({ to, link }, "magic link (console mailer)");
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.AUTH_EMAIL_FROM ?? "pickups@biktrix.com",
      to,
      subject: "Sign in to Biktrix Pickups",
      text: `Click to sign in (link expires in 15 minutes):\n\n${link}\n\nIf you didn't request this, ignore this email.`,
    }),
  });
  if (!res.ok) throw new Error(`Mailer failed: ${res.status}`);
}
