import { Suspense } from "react";
import { PendingIndicator } from "@/components/pending-indicator";

export const metadata = { title: { default: "Book an appointment · Biktrix", template: "%s · Biktrix" } };

/**
 * Inside the website embed (an iframe from /embed.js): hide our header and tell the parent page how tall the
 * content is, so the frame grows and is shown. Plain inline script, not a React component, so it runs as the HTML
 * arrives instead of after the page's JavaScript has downloaded and started (saves a few hundred ms on a first
 * visit). Does nothing on the full page.
 */
const FRAME_SIZER = `(function(){if(window.parent===window)return;var d=document.documentElement;d.classList.add("in-embed");
var last=0;function post(){var h=d.scrollHeight;if(h!==last){last=h;window.parent.postMessage({type:"biktrix-booking:height",height:h},"*");}}
post();if(window.ResizeObserver)new ResizeObserver(post).observe(document.body);document.addEventListener("DOMContentLoaded",post);window.addEventListener("load",post);})();`;

/** Public booking pages (any profile's booking types). Same frame as the pickup link pages. */
export default function PublicBookingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <Suspense fallback={null}><PendingIndicator /></Suspense>
      <script dangerouslySetInnerHTML={{ __html: FRAME_SIZER }} />
      <header className="booking-header border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-3">
          <span className="text-sm font-semibold uppercase tracking-widest text-accent">Biktrix</span>
          <span className="text-sm text-muted">Book an appointment</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
