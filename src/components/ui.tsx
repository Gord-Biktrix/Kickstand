import Link from "next/link";
import type { ReactNode } from "react";

type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";

const toneClass: Record<Tone, string> = {
  neutral: "border-border bg-neutral-100 text-neutral-800",
  accent: "border-accent/30 bg-accent-soft text-accent-strong",
  ok: "border-ok/30 bg-ok-soft text-ok",
  warn: "border-warn/30 bg-warn-soft text-warn",
  danger: "border-danger/30 bg-danger-soft text-danger",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${toneClass[tone]}`}>{children}</span>;
}

export function Alert({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`rounded-lg border px-4 py-3 text-sm ${toneClass[tone]}`}>
      {children}
    </div>
  );
}

export function Card({ children, className = "", title, action }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="mb-3 flex items-start justify-between gap-3">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Field({ label, htmlFor, hint, children, error }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; children: ReactNode; error?: string }) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="hint">{hint}</p>}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted">{children}</p>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Flash({ ok, error }: { ok?: string; error?: string }) {
  if (!ok && !error) return null;
  return (
    <div className="mb-4 space-y-2">
      {ok && <Alert tone="ok">{ok}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

export function LinkButton({ href, children, className = "", primary = false }: { href: string; children: ReactNode; className?: string; primary?: boolean }) {
  return (
    <Link href={href} className={`btn ${primary ? "btn-primary" : ""} ${className}`}>
      {children}
    </Link>
  );
}

export function Dl({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
