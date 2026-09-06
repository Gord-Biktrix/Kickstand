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

/** Staff invitation: a welcome plus a sign-in link that stays valid for a week. Resend when configured, console otherwise. */
export async function sendInviteEmail(to: string, args: { name: string; inviter: string; showroom: string; link: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const text = `Hi ${args.name},

${args.inviter} has added you to Biktrix Pickups (Kickstand) for ${args.showroom}.

Click to sign in — the link works for 7 days and signs you in for 30 days on the device you use:

${args.link}

After that, sign in any time at ${args.link.split("/auth/")[0]}/login with this email address; we send a fresh link each time. No password needed.

Questions? Reply to this email.`;
  if (!apiKey) {
    logger.info({ to, link: args.link }, "staff invite (console mailer)");
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.AUTH_EMAIL_FROM ?? "pickups@biktrix.com",
      to,
      subject: `You're invited to Biktrix Pickups — ${args.showroom}`,
      text,
    }),
  });
  if (!res.ok) throw new Error(`Mailer failed: ${res.status}`);
}
