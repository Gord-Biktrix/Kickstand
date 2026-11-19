import Link from "next/link";
import type { BookingType } from "@/db/schema";
import { CopyButton } from "@/components/copy-button";
import { colorOf } from "@/lib/booking-types";
import { EMBED_HOWS, embedSnippet, type EmbedHow } from "@/lib/embed-script";

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Calendly-style "Share": the link, and the website code three ways (inline, popup button, popup link), with a
 * preview. `t` null = the store's whole list. Options are a GET form so the code updates without JavaScript.
 */
export function SharePanel({
  t, storeSlug: ownSlug, storeName, root, close, how, text, color, textColor, scope,
}: { t: BookingType | null; storeSlug: string; storeName: string; root: string; close: string; how: EmbedHow; text?: string; color?: string; textColor?: string; scope?: string }) {
  // A type in the all-showrooms directory can be shared as this store's page or as the directory (/book/all/<slug>).
  const directory = !!t?.inDirectory;
  const all = directory && scope === "all";
  const storeSlug = all ? "all" : ownSlug;
  const name = t ? (all ? `${t.name} · all showrooms` : t.name) : `${storeName} booking page`;
  const link = `${root}/book/${storeSlug}${t ? `/${t.slug}` : ""}`;
  const label = (text ?? "").trim().slice(0, 60) || (t ? `Book a ${t.name.toLowerCase()}` : "Book an appointment");
  const bg = color && HEX.test(color) ? color : t ? colorOf(t.color).hex : "#ff6b1a";
  const fg = textColor && HEX.test(textColor) ? textColor : "#ffffff";
  const code = embedSnippet({ root, store: storeSlug, type: t?.slug ?? null, how, text: label, color: bg, textColor: fg });
  const shareId = t?.id ?? "all";
  const scopeQ = all ? "&scope=all" : "";
  const tab = (h: EmbedHow) => `${close}?share=${shareId}&how=${h}${scopeQ}`;
  const info = EMBED_HOWS.find((h) => h.key === how)!;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" role="dialog" aria-modal="true" aria-label={`Share ${name}`}>
      <Link href={close} className="absolute inset-0" aria-label="Close" tabIndex={-1} />
      <div className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto bg-card shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <p className="text-xs font-bold tracking-wider text-muted uppercase">Share</p>
            <h2 className="text-lg font-semibold">{name}</h2>
          </div>
          <Link href={close} className="btn btn-sm" aria-label="Close">✕</Link>
        </header>

        {directory && (
          <nav aria-label="Which page" className="mx-5 mt-4 flex gap-1 rounded-lg bg-background p-1 text-sm">
            {[{ key: "store", label: storeName, href: `${close}?share=${shareId}&how=${how}` }, { key: "all", label: "All showrooms", href: `${close}?share=${shareId}&how=${how}&scope=all` }].map((o) => {
              const on = (o.key === "all") === all;
              return <Link key={o.key} href={o.href} aria-current={on ? "page" : undefined} className={`flex-1 rounded-md px-3 py-2 text-center ${on ? "bg-card font-semibold shadow-sm" : "text-muted hover:text-foreground"}`}>{o.label}</Link>;
            })}
          </nav>
        )}

        <section className="space-y-2 border-b border-border px-5 py-4">
          <h3 className="text-sm font-semibold">Link</h3>
          <p className="text-sm text-muted">Send it in an email, text or chat, or put it behind any button.</p>
          <div className="flex items-center gap-2">
            <input readOnly value={link} aria-label="Booking link" className="input flex-1 text-sm" />
            <CopyButton text={link} />
          </div>
        </section>

        <section className="space-y-3 px-5 py-4">
          <h3 className="text-sm font-semibold">Add to the website</h3>
          <nav aria-label="How to show it" className="flex gap-1 rounded-lg bg-background p-1 text-sm">
            {EMBED_HOWS.map((h) => (
              <Link key={h.key} href={tab(h.key)} aria-current={h.key === how ? "page" : undefined} className={`flex-1 rounded-md px-3 py-2 text-center ${h.key === how ? "bg-card font-semibold shadow-sm" : "text-muted hover:text-foreground"}`}>
                {h.label}
              </Link>
            ))}
          </nav>
          <p className="text-sm text-muted">{info.hint}</p>

          {how !== "inline" && (
            <form method="get" action={close} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
              <input type="hidden" name="share" value={shareId} />
              <input type="hidden" name="how" value={how} />
              {all && <input type="hidden" name="scope" value="all" />}
              <label className="text-sm">
                <span className="mb-1 block font-medium">{how === "button" ? "Button text" : "Link text"}</span>
                <input name="text" defaultValue={label} maxLength={60} className="input" />
              </label>
              {how === "button" && (
                <>
                  <label className="text-sm"><span className="mb-1 block font-medium">Colour</span><input type="color" name="color" defaultValue={bg} className="h-10 w-14 rounded border border-border" /></label>
                  <label className="text-sm"><span className="mb-1 block font-medium">Text</span><input type="color" name="text_color" defaultValue={fg} className="h-10 w-14 rounded border border-border" /></label>
                </>
              )}
              <button type="submit" className="btn btn-sm">Update</button>
            </form>
          )}

          <Preview how={how} link={link} label={label} bg={bg} fg={fg} />

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-medium">Code</span>
              <CopyButton text={code} label="Copy code" />
            </div>
            <pre className="overflow-x-auto rounded-lg bg-foreground p-3 text-xs text-white"><code>{code}</code></pre>
          </div>

          <details className="text-sm text-muted">
            <summary className="cursor-pointer">Where to paste it, and filling in the customer&apos;s details</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li><strong>Shopify:</strong> add a <em>Custom Liquid</em> block to the page or section and paste the code. The script line only needs to be on the page once, even with several embeds.</li>
              <li>Add <code className="text-xs">data-name</code>, <code className="text-xs">data-email</code> or <code className="text-xs">data-phone</code> to fill in the form. On Shopify, for signed-in customers: <code className="text-xs">data-email=&quot;{"{{ customer.email }}"}&quot; data-name=&quot;{"{{ customer.name }}"}&quot;</code></li>
              <li>Links work the same way: add <code className="text-xs">?name=…&amp;email=…</code> to the link.</li>
              <li>It works on biktrix.ca and Shopify. Other sites need adding in Vercel (<code className="text-xs">BOOKING_EMBED_ORIGINS</code>).</li>
            </ul>
          </details>
        </section>
      </div>
    </div>
  );
}

function Preview({ how, link, label, bg, fg }: { how: EmbedHow; link: string; label: string; bg: string; fg: string }) {
  if (how === "inline") {
    return (
      <div className="overflow-hidden rounded-lg border border-border">
        <p className="border-b border-border bg-background px-3 py-1.5 text-xs text-muted">Preview</p>
        <iframe src={link.replace(/^https?:\/\/[^/]+/, "")} title="Preview of the inline booking calendar" className="h-[420px] w-full" />
      </div>
    );
  }
  return (
    <div aria-label="Preview" className="relative h-44 overflow-hidden rounded-lg border border-border bg-background">
      <p className="border-b border-border bg-card px-3 py-1.5 text-xs text-muted">Preview · your web page</p>
      <div className="space-y-2 p-4" aria-hidden="true">
        <div className="h-3 w-2/3 rounded bg-border" />
        <div className="h-3 w-1/2 rounded bg-border" />
        {how === "link" ? (
          <p className="pt-1 text-sm">Come and ride one. <span className="font-semibold text-accent underline">{label}</span></p>
        ) : (
          <div className="h-3 w-3/5 rounded bg-border" />
        )}
      </div>
      {how === "button" && (
        <span className="absolute right-3 bottom-3 rounded-full px-4 py-2.5 text-sm font-bold shadow-lg" style={{ background: bg, color: fg }}>{label}</span>
      )}
    </div>
  );
}
