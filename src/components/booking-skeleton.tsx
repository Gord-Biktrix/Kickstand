import { PAGE_SKELETON } from "@/lib/booking-skeleton-html";

/**
 * Shown while a booking page loads (streamed first, so the frame appears at once): the card's outline, the same
 * shape and height as the real calendar, shimmering. Shared with the website embed (booking-skeleton-html.ts).
 */
export function BookingSkeleton() {
  return <div dangerouslySetInnerHTML={{ __html: PAGE_SKELETON }} />;
}
