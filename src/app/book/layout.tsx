import { Suspense } from "react";
import { PendingIndicator } from "@/components/pending-indicator";
import { FrameSizer } from "./frame-sizer";

export const metadata = { title: { default: "Book an appointment · Biktrix", template: "%s · Biktrix" } };

/** Public booking pages (any profile's booking types). Same frame as the pickup link pages. */
export default function PublicBookingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <Suspense fallback={null}><PendingIndicator /></Suspense>
      <FrameSizer />
      <header className="booking-header border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-md items-center justify-between px-4 py-3">
          <span className="text-sm font-semibold uppercase tracking-widest text-accent">Biktrix</span>
          <span className="text-sm text-muted">Book an appointment</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-md flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
