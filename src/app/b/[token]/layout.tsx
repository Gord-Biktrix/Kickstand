export default function CustomerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-md items-center justify-between px-4 py-3">
          <span className="text-sm font-semibold uppercase tracking-widest text-accent">Biktrix</span>
          <span className="text-sm text-muted">Book your pickup</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-md flex-1 px-4 py-6">{children}</main>
      <footer className="mx-auto w-full max-w-md px-4 py-6 text-xs text-muted">
        Questions? Call the showroom — the number is on this page. Times are shown in Pacific time.
      </footer>
    </div>
  );
}
