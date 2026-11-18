import { db } from "@/db/client";
import { handleTwilioWebhook } from "@/lib/twilio-webhook";

/** Twilio delivery updates for texts Kickstand sent (sent, delivered, undelivered, failed). */
export async function POST(request: Request) {
  return handleTwilioWebhook(db, request, "status");
}
