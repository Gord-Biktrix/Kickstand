/**
 * Public booking pages are the same for every visitor, so Vercel's CDN keeps a copy for 30 s and refreshes it in
 * the background (like Calendly serving a cached page): most visitors get it in tens of ms and never wait on the
 * database. Slots may be up to ~90 s stale; booking re-checks the slot and says "just taken" if it's gone. The
 * browser itself still doesn't cache (Next's own Cache-Control stays private). Applied in next.config.ts (a header
 * set in the proxy is ignored by the CDN). Not cached: manage links (/book/m/…, personal), links carrying a
 * customer's details, and pages showing an error.
 */
export const BOOKING_CDN_CACHE = "max-age=30, stale-while-revalidate=60";
export const PERSONAL_PARAMS = ["name", "email", "phone", "error"];
