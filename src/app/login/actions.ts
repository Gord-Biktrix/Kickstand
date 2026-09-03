"use server";

import { redirect } from "next/navigation";
import { requestMagicLink } from "@/lib/auth";
import { str } from "@/lib/flash";

export async function requestLoginAction(formData: FormData) {
  const result = await requestMagicLink(str(formData, "email"));
  if (!result.ok) redirect(`/login?error=${encodeURIComponent(result.error)}`);
  const dev = result.devLink ? `&dev=${encodeURIComponent(result.devLink)}` : "";
  redirect(`/login?sent=1${dev}`);
}
