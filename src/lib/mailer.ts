import nodemailer from "nodemailer";
import { logger } from "./logger";

/**
 * Staff email (sign-in links, invitations, welcomes). Transport, in order of preference:
 *  1. SMTP — SMTP_USER + SMTP_PASS (Google Workspace: smtp.gmail.com with an App Password; no DNS needed
 *     because Google already authenticates biktrix.com mail). SMTP_HOST/SMTP_PORT default to Gmail.
 *  2. Resend — RESEND_API_KEY (needs the sender domain verified in Resend).
 *  3. Console — nothing configured; the message (and any link) is logged instead.
 * From: AUTH_EMAIL_FROM, falling back to the SMTP user. Gmail rewrites From to the account (or one of its
 * "Send mail as" aliases), so set AUTH_EMAIL_FROM to the mailbox you authenticate with.
 */
export type Mail = { to: string; subject: string; text: string };

export function mailerKind(): "smtp" | "resend" | "console" {
  if (process.env.SMTP_USER && process.env.SMTP_PASS) return "smtp";
  if (process.env.RESEND_API_KEY) return "resend";
  return "console";
}

function fromAddress(): string {
  return process.env.AUTH_EMAIL_FROM || process.env.SMTP_USER || "pickups@biktrix.com";
}

export async function deliver(mail: Mail, logHint: Record<string, unknown> = {}): Promise<void> {
  const kind = mailerKind();
  if (kind === "console") {
    logger.info({ to: mail.to, subject: mail.subject, ...logHint }, "mail (console mailer)");
    return;
  }
  if (kind === "smtp") {
    const port = Number(process.env.SMTP_PORT ?? 465);
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST ?? "smtp.gmail.com",
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    try {
      await transport.sendMail({ from: fromAddress(), to: mail.to, subject: mail.subject, text: mail.text });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error({ detail }, "smtp mailer failed");
      throw new Error(`Email couldn't be sent (SMTP: ${detail}). Check SMTP_USER / SMTP_PASS (a Google App Password) in Vercel.`);
    }
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: fromAddress(), to: mail.to, subject: mail.subject, text: mail.text }),
  });
  if (!res.ok) throw await resendError(res);
}

/** Resend answers 4xx with `{ message }` ("The biktrix.com domain is not verified…"); surface that, it's what staff need to see. */
async function resendError(res: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as { message?: string; name?: string };
    detail = body.message ?? body.name ?? "";
  } catch {
    /* no JSON body */
  }
  logger.error({ status: res.status, detail }, "resend mailer failed");
  return new Error(`Email couldn't be sent (${res.status}${detail ? `: ${detail}` : ""}). Check RESEND_API_KEY / AUTH_EMAIL_FROM and that the sender domain is verified in Resend.`);
}

/** Staff magic-link email (15-minute link). */
export async function sendMagicLinkEmail(to: string, link: string): Promise<void> {
  await deliver(
    {
      to,
      subject: "Sign in to Kickstand",
      text: `Click to sign in (link expires in 15 minutes):\n\n${link}\n\nIf you didn't request this, ignore this email.`,
    },
    { link },
  );
}

/** Staff invitation: a welcome plus a sign-in link that stays valid for a week. */
export async function sendInviteEmail(to: string, args: { name: string; inviter: string; showroom: string; link: string }): Promise<void> {
  await deliver(
    {
      to,
      subject: `You're invited to Kickstand — ${args.showroom}`,
      text: `Hi ${args.name},\n\n${args.inviter} has added you to Kickstand, the Biktrix pickup scheduler, for ${args.showroom}.\n\nClick to sign in — the link works for 7 days and signs you in for 30 days on the device you use:\n\n${args.link}\n\nAfter that, sign in any time at ${args.link.split("/auth/")[0]}/login with this email address; we send a fresh link each time. No password needed.\n\nQuestions? Reply to this email.`,
    },
    { link: args.link },
  );
}

/** Welcome when Google sign-in is on: no link to click, just where to go and how to sign in. */
export async function sendWelcomeEmail(to: string, args: { name: string; inviter: string; showroom: string; url: string }): Promise<void> {
  await deliver({
    to,
    subject: `You've been added to Kickstand — ${args.showroom}`,
    text: `Hi ${args.name},\n\n${args.inviter} has added you to Kickstand, the Biktrix pickup scheduler, for ${args.showroom}.\n\nSign in here with your Biktrix Google account:\n\n${args.url}/login\n\nOnce you're in, you can set an optional password under your name (top right) for shared shop computers.\n\nQuestions? Reply to this email.`,
  });
}
