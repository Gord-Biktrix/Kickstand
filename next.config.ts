import type { NextConfig } from "next";
import { BOOKING_CDN_CACHE, PERSONAL_PARAMS } from "./src/lib/booking-cache";

/**
 * Sites allowed to embed the public booking pages (/book/*, via /embed.js). biktrix.ca runs on Shopify, so the
 * theme editor's preview hosts are allowed too. Add more, space-separated, in BOOKING_EMBED_ORIGINS.
 */
const EMBED_ORIGINS = [
  "https://biktrix.ca",
  "https://*.biktrix.ca",
  "https://*.myshopify.com",
  "https://admin.shopify.com",
  ...(process.env.BOOKING_EMBED_ORIGINS ?? "").split(/\s+/).filter(Boolean),
].join(" ");

const nextConfig: NextConfig = {
  reactCompiler: true,
  async headers() {
    return [
      // Staff app and pickup links: never inside someone else's frame (clickjacking).
      { source: "/app/:path*", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'self'" }, { key: "X-Frame-Options", value: "SAMEORIGIN" }] },
      { source: "/b/:path*", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'self'" }] },
      // Public booking pages: embeddable on Biktrix sites only.
      { source: "/book/:path*", headers: [{ key: "Content-Security-Policy", value: `frame-ancestors 'self' ${EMBED_ORIGINS}` }] },
      // Public booking pages: Vercel's CDN keeps a 30 s copy (src/lib/booking-cache.ts says why it's safe). Not the
      // manage links (/book/m/…), and not links carrying a customer's details or an error.
      ...["/book/:profile((?!m/|m$)[^/]+)", "/book/:profile((?!m/|m$)[^/]+)/:type"].map((source) => ({
        source,
        missing: PERSONAL_PARAMS.map((key) => ({ type: "query" as const, key })),
        headers: [{ key: "Vercel-CDN-Cache-Control", value: BOOKING_CDN_CACHE }],
      })),
    ];
  },
};

export default nextConfig;
