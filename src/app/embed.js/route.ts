import { embedScript } from "@/lib/embed-script";
import { baseUrl } from "@/lib/messages";

/**
 * The website embed, three ways (like Calendly), on any page of an allowed site (BOOKING_EMBED_ORIGINS in
 * next.config.ts). Load the script once per page:
 *
 *   <script src="https://<kickstand>/embed.js" async></script>
 *
 * Inline — the booking calendar in the page, growing to fit:
 *   <div data-biktrix-booking="vancouver" data-type="test-ride"></div>
 *
 * Popup button — a floating button in the bottom-right corner that opens the calendar over the page:
 *   <div data-biktrix-popup-button="vancouver" data-type="test-ride" data-text="Book a test ride"
 *        data-color="#ff6b1a" data-text-color="#17181a"></div>
 *
 * Popup link — any element; clicking it opens the calendar over the page:
 *   <a href="https://<kickstand>/book/vancouver/test-ride" data-biktrix-popup="vancouver" data-type="test-ride">Book a test ride</a>
 *
 * Every form takes data-name / data-email / data-phone to fill in the customer's details, and data-type is
 * optional (without it the store's list of types shows). Scripts can also call
 * window.BiktrixBooking.open("vancouver", "test-ride", { name, email, phone }).
 */
export function GET() {
  return new Response(embedScript(baseUrl()), {
    headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}
