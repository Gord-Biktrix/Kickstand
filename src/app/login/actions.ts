"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { requestMagicLink, SESSION_COOKIE, sessionCookieOptions, signInWithPassword } from "@/lib/auth";
import { str } from "@/lib/flash";

export async function requestLoginAction(formData: FormData) {
  const result = await requestMagicLink(str(formData, "email"));
  if (!result.ok) redirect(`/login?error=${encodeURIComponent(result.error)}&mode=link`);
  const dev = result.devLink ? `&dev=${encodeURIComponent(result.devLink)}` : "";
  redirect(`/login?sent=1${dev}`);
}

export async function passwordLoginAction(formData: FormData) {
  const email = str(formData, "email");
  const result = await signInWithPassword(email, str(formData, "password"));
  if (!result.ok) redirect(`/login?error=${result.error === "locked" ? "locked" : "password"}&email=${encodeURIComponent(email)}`);
  (await cookies()).set(SESSION_COOKIE, result.session, sessionCookieOptions());
  redirect("/app");
}
