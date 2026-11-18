import { db } from "@/db/client";
import { handleTwilioWebhook } from "@/lib/twilio-webhook";

/** Twilio "A message comes in" webhook for every store number (docs/kickstand-chat.md). */
export async function POST(request: Request) {
  return handleTwilioWebhook(db, request, "inbound");
}
