import { NextResponse, type NextRequest } from "next/server";

const WINDOW_MS = 60_000;
const LIMIT = 60;
const hits = new Map<string, { count: number; resetAt: number }>();

/**
 * §13: rate-limit /b/* to 60 req/min per IP and bounce signed-out visitors away from /app.
 * The limiter is per-instance memory; on Vercel put a WAF rule or Upstash in front for hard limits.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/b/")) {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip") ??
      "unknown";
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || entry.resetAt < now) {
      hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    } else if (++entry.count > LIMIT) {
      return new NextResponse("Too many requests", {
        status: 429,
        headers: { "Retry-After": String(Math.ceil((entry.resetAt - now) / 1000)) },
      });
    }
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/app")) {
    // Optimistic check only; every page and action re-verifies the session server-side.
    if (!request.cookies.get("pickup_session")) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/b/:path*", "/app/:path*"],
};
