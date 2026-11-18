"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageView, PanelJob, ThreadFilter, ThreadRow, ThreadView } from "@/lib/chat-view";
import { segmentCount } from "@/lib/sms-text";
import { chatTrackerLinkAction, markChatReadAction, newChatAction, sendChatAction } from "../actions";

const POLL_MS = 5000;
const STEP_LABEL = { checked_in: "Check in", inspection: "Inspect", repair: "Repair", pickup: "Pickup" } as const;
const CHIP_TONE = { ok: "bg-warn-soft text-warn", booked: "bg-accent-soft text-accent-strong", stop: "bg-danger-soft text-danger" } as const;

function initials(name: string | null): string {
  if (!name) return "?";
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
}

function formatPhone(e164: string): string {
  const d = e164.replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : e164;
}

function href(params: { c?: string | null; q?: string; f?: ThreadFilter }): string {
  const u = new URLSearchParams();
  if (params.c) u.set("c", params.c);
  if (params.q) u.set("q", params.q);
  if (params.f && params.f !== "all") u.set("f", params.f);
  const s = u.toString();
  return s ? `/app/messages?${s}` : "/app/messages";
}

/** Shrink a photo in the browser to something a phone can receive as MMS (Twilio caps a message at 5 MB). */
async function photoDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = () => fail(new Error("unreadable")); img.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function Inbox(props: {
  initialThreads: ThreadRow[];
  initialThread: ThreadView | null;
  selected: string | null;
  q: string;
  filter: ThreadFilter;
  closes: string | null;
  showNew: boolean;
  error?: string;
}) {
  const { selected, q, filter } = props;
  const [threads, setThreads] = useState(props.initialThreads);
  const [thread, setThread] = useState(props.initialThread);

  const poll = useCallback(async () => {
    const u = new URLSearchParams({ q, f: filter });
    if (selected) u.set("c", selected);
    try {
      const res = await fetch(`/api/chat/poll?${u}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { threads: ThreadRow[]; thread: ThreadView | null };
      setThreads(data.threads);
      if (selected) setThread(data.thread);
      if (selected && data.threads.find((t) => t.id === selected)?.unread && document.visibilityState === "visible") {
        await markChatReadAction(selected);
      }
    } catch {
      // Offline for a moment: the next tick tries again.
    }
  }, [q, filter, selected]);

  useEffect(() => {
    if (selected && props.initialThreads.find((t) => t.id === selected)?.unread) {
      markChatReadAction(selected).then(poll);
    }
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") poll();
    }, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // Mount only: the page remounts this (key) when the thread, search or filter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unread = threads.filter((t) => t.unread).length;

  return (
    <div className="-my-2 flex h-[calc(100dvh-8.5rem)] min-h-[480px] gap-4">
      <section aria-label="Conversations" className={`${selected ? "hidden md:flex" : "flex"} w-full min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card md:w-[340px] md:shrink-0 lg:w-[360px]`}>
        <div className="flex flex-col gap-2.5 border-b border-background p-3.5">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-extrabold">Messages</h1>
            <Link href={`${href({ q, f: filter })}${q || filter !== "all" ? "&" : "?"}new=1`} aria-label="New message" className="flex h-9 w-9 items-center justify-center rounded-lg border border-border hover:bg-background">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
            </Link>
          </div>
          {props.showNew && (
            <form action={newChatAction} className="flex gap-2">
              <input name="phone" type="tel" required autoFocus placeholder="Phone number" aria-label="Phone number" className="input h-10 min-w-0 flex-1" />
              <button type="submit" className="btn btn-primary h-10 py-0">Open</button>
            </form>
          )}
          {props.error && <p className="text-sm text-danger">{props.error}</p>}
          <form action="/app/messages" role="search" className="flex h-10 items-center gap-2 rounded-lg border border-border px-2.5 text-muted">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            {filter !== "all" && <input type="hidden" name="f" value={filter} />}
            <input name="q" type="search" defaultValue={q} placeholder="Name, phone or WO #" aria-label="Search messages" className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none" />
          </form>
          <nav aria-label="Filter" className="flex gap-1.5 text-[13px] font-semibold">
            {(
              [
                ["all", "All"],
                ["unread", unread ? `Unread ${unread}` : "Unread"],
                ["ok", "Waiting on OK"],
              ] as const
            ).map(([f, label]) => (
              <Link key={f} href={href({ q, f })} aria-current={filter === f ? "page" : undefined} className={`rounded-full px-3 py-1.5 ${filter === f ? "bg-chrome text-white" : "border border-border hover:bg-background"}`}>
                {label}
              </Link>
            ))}
          </nav>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {threads.map((t) => (
            <li key={t.id}>
              <Link
                href={href({ c: t.id, q, f: filter })}
                aria-current={t.id === selected ? "true" : undefined}
                className={`flex gap-2.5 border-b border-l-[3px] border-b-[#f1efeb] px-3.5 py-3 ${t.id === selected ? "border-l-action bg-accent-soft" : "border-l-transparent hover:bg-background/60"}`}
              >
                <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#e4e0d9] text-[13px] font-bold text-[#4a4d52]">{initials(t.name)}</span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex justify-between gap-2">
                    <span className={`truncate text-sm ${t.unread ? "font-bold" : ""}`}>{t.name ?? formatPhone(t.phone)}</span>
                    <span className="shrink-0 text-xs text-muted">{t.lastAt}</span>
                  </span>
                  <span className={`truncate text-[13px] text-[#4a4d52] ${t.unread ? "font-bold" : ""}`}>{t.preview}</span>
                  {t.chip && <span className={`self-start rounded px-1.5 py-0.5 text-[11px] font-bold ${CHIP_TONE[t.chip.kind]}`}>{t.chip.label}</span>}
                </span>
                {t.unread && <span aria-label="Unread" className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-action" />}
              </Link>
            </li>
          ))}
          {threads.length === 0 && <li className="p-6 text-center text-sm text-muted">{q || filter !== "all" ? "Nothing matches." : "No texts yet."}</li>}
        </ul>
      </section>

      {thread ? (
        <>
          <Conversation key={thread.conversation.id} thread={thread} back={href({ q, f: filter })} closes={props.closes} onSent={poll} />
          <Panel thread={thread} />
        </>
      ) : (
        <section aria-label="Conversation" className="hidden flex-1 items-center justify-center rounded-xl border border-border bg-card text-sm text-muted md:flex">
          {selected ? "That conversation isn't in this store." : "Pick a conversation."}
        </section>
      )}
    </div>
  );
}

function Conversation({ thread, back, closes, onSent }: { thread: ThreadView; back: string; closes: string | null; onSent: () => Promise<void> }) {
  const c = thread.conversation;
  const name = c.name ?? formatPhone(c.phone);
  const [body, setBody] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const lastId = thread.messages.at(-1)?.id;

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lastId]);

  function insert(s: string) {
    setBody((b) => (b.trim() ? `${b.trimEnd()} ${s}` : s));
    text.current?.focus();
  }

  async function trackerLink() {
    const r = await chatTrackerLinkAction(c.id);
    if (r.ok) insert(`Follow along here: ${r.url}`);
    else setError(r.error);
  }

  async function send() {
    if (busy || (!body.trim() && !photos.length)) return;
    setBusy(true);
    setError(null);
    const r = await sendChatAction(c.id, body, photos);
    if (r.ok) {
      setBody("");
      setPhotos([]);
    } else setError(r.error);
    await onSent();
    setBusy(false);
  }

  async function addPhotos(files: FileList) {
    try {
      const urls = await Promise.all([...files].slice(0, 5 - photos.length).map(photoDataUrl));
      setPhotos((p) => [...p, ...urls].slice(0, 5));
    } catch {
      setError("That photo couldn't be opened. Try a JPEG or PNG.");
    }
  }

  // Quick replies fill the box (staff can edit before sending); "Send tracker link" fetches the link first.
  const quick: { label: string; text: string | null }[] = [
    { label: "Ready for pickup", text: "Good news, your bike is ready for pickup!" },
    ...(thread.job ? [{ label: "Send tracker link", text: null }] : []),
    ...(closes ? [{ label: `We're open till ${closes}`, text: `We're open till ${closes} today.` }] : []),
    { label: "Call me?", text: "Is now a good time to give you a call?" },
  ];
  const segments = segmentCount(body);
  const blocked = !thread.canSend;

  return (
    <section aria-label={`Conversation with ${name}`} className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-3 border-b border-background px-3 py-2.5 md:px-4.5">
        <Link href={back} aria-label="Back to messages" className="flex h-11 w-9 items-center justify-center text-2xl md:hidden">‹</Link>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[17px] font-extrabold">{name}</span>
          <span className="truncate text-[13px] text-muted">{formatPhone(c.phone)}{thread.job ? ` · ${thread.job.title}` : ""}</span>
        </div>
        <Link href={thread.customerHref} className="shrink-0 text-[13px] font-semibold text-accent hover:text-accent-strong">Customer page</Link>
      </div>

      {thread.job && <JobStrip job={thread.job} />}

      <div ref={scroller} className="flex flex-1 flex-col gap-2.5 overflow-y-auto bg-[#f7f5f1] p-3 md:p-4.5">
        {thread.messages.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
      </div>

      <div className="flex flex-col gap-2.5 border-t border-background px-3 py-3 md:px-3.5">
        {blocked ? (
          <p className="text-sm text-muted">{c.optedOut ? "Opted out (texted STOP)." : thread.lineState === "no_number" ? "No texting number for this store yet." : "Texting is off for this store."}</p>
        ) : (
          <>
            <div className="flex gap-1.5 overflow-x-auto">
              {quick.map(({ label, text: reply }) => (
                <button key={label} type="button" onClick={() => (reply === null ? trackerLink() : insert(reply))} className="shrink-0 rounded-full border border-border px-3 py-1.5 text-[13px] font-semibold hover:bg-background">
                  {label}
                </button>
              ))}
            </div>
            {photos.length > 0 && (
              <div className="flex gap-2">
                {photos.map((p, i) => (
                  <span key={i} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p} alt="" className="h-16 w-16 rounded-lg object-cover" />
                    <button type="button" aria-label="Remove photo" onClick={() => setPhotos((ps) => ps.filter((_, j) => j !== i))} className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-chrome text-xs text-white">×</button>
                  </span>
                ))}
              </div>
            )}
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <input ref={fileInput} type="file" accept="image/*" multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => e.target.files && addPhotos(e.target.files).then(() => (e.target.value = ""))} />
              <button type="button" aria-label="Attach photo" onClick={() => fileInput.current?.click()} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-border hover:bg-background">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="11" r="2" /><path d="m21 17-5-5-8 7" /></svg>
              </button>
              <textarea
                ref={text}
                rows={1}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={`Text ${c.name?.split(/\s+/)[0] ?? name}…`}
                aria-label="Message"
                className="max-h-40 min-h-11 flex-1 resize-none rounded-[10px] border border-[#cfcbc4] px-3 py-[11px] text-sm [field-sizing:content] focus:outline-2 focus:outline-action"
              />
              <button type="submit" disabled={busy} aria-busy={busy} className="h-11 shrink-0 rounded-[10px] bg-action px-4.5 text-[15px] font-extrabold text-chrome hover:bg-action-strong disabled:opacity-60">
                Send
              </button>
            </form>
            {(segments > 1 || error) && (
              <p className={`text-xs ${error ? "text-danger" : "text-muted"}`}>{error ?? `${segments} texts`}</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Bubble({ m }: { m: MessageView }) {
  const out = m.direction === "out";
  const meta = out
    ? [m.kind === "auto" ? null : m.who, m.time, m.error ?? m.status].filter(Boolean).join(" · ")
    : m.time;
  return (
    <>
      {m.day && <div className="self-center py-1 text-xs font-semibold text-muted">{m.day}</div>}
      <div className={`flex max-w-[82%] flex-col gap-1 md:max-w-[72%] ${out ? "items-end self-end" : "self-start"}`}>
        {m.photos.map((src, i) => (
          <a key={i} href={src} target="_blank" rel="noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={out ? "Photo sent" : "Customer photo"} className="max-h-60 max-w-[240px] rounded-xl object-cover" />
          </a>
        ))}
        {m.body && (
          <div
            className={`px-3 py-2.5 text-sm leading-[1.45] whitespace-pre-wrap break-words ${
              !out
                ? "rounded-[14px_14px_14px_4px] border border-border bg-card"
                : m.kind === "auto"
                  ? "rounded-[14px_14px_4px_14px] border-[1.5px] border-dashed border-[#c9c3ba] bg-card"
                  : "rounded-[14px_14px_4px_14px] bg-chrome text-white"
            }`}
          >
            {m.body}
          </div>
        )}
        <span className={`text-[11px] ${m.error ? "text-danger" : "text-muted"}`}>
          {m.kind === "auto" && <span className="font-bold text-accent">AUTO{m.autoTag ? ` · ${m.autoTag}` : ""} · </span>}
          {meta}
        </span>
      </div>
    </>
  );
}

function StepBar({ job }: { job: PanelJob }) {
  const at = job.steps.indexOf(job.step);
  return (
    <div>
      <div className="grid grid-cols-4 gap-1">
        {job.steps.map((s, i) => (
          <span key={s} className={`h-1.5 rounded-sm ${i < at ? "bg-chrome" : i === at ? "bg-action" : "bg-[#e4e0d9]"}`} />
        ))}
      </div>
      <div className="mt-1 grid grid-cols-4 text-[11px] text-muted">
        {job.steps.map((s, i) => (
          <span key={s} className={i === at ? "font-bold text-foreground" : ""}>{STEP_LABEL[s]}</span>
        ))}
      </div>
    </div>
  );
}

/** The job, above the conversation, where the side panel doesn't fit (phone, iPad portrait). */
function JobStrip({ job }: { job: PanelJob }) {
  return (
    <Link href={job.href} className="mx-3 mt-2.5 flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 xl:hidden">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-extrabold">WO #{job.workorderId} · {job.title}</span>
        <span className="truncate text-xs text-muted">{job.waiting ? `${job.waiting.title} $${job.waiting.price.toFixed(2)} sent for OK ${job.waiting.sentAt}` : STEP_LABEL[job.step]}</span>
      </span>
      {job.waiting && <span className="shrink-0 rounded bg-warn-soft px-1.5 py-0.5 text-[11px] font-bold text-warn">Waiting on OK</span>}
    </Link>
  );
}

function Panel({ thread }: { thread: ThreadView }) {
  const job = thread.job;
  return (
    <aside aria-label="Customer" className="hidden w-[300px] shrink-0 flex-col gap-3 overflow-y-auto xl:flex">
      {job && (
        <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4">
          <span className="text-xs font-bold tracking-[0.08em] text-muted">OPEN JOB</span>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-base font-extrabold">WO #{job.workorderId}</span>
            {job.waiting && <span className="rounded bg-warn-soft px-1.5 py-0.5 text-xs font-bold text-warn">Waiting on OK</span>}
          </div>
          <span className="text-sm text-[#4a4d52]">{job.title}</span>
          <StepBar job={job} />
          {job.waiting && (
            <>
              <div className="flex justify-between gap-2 border-t border-background pt-2.5 text-sm">
                <span>{job.waiting.title}</span>
                <span className="font-bold">${job.waiting.price.toFixed(2)}</span>
              </div>
              <span className="text-xs text-muted">Sent for OK {job.waiting.sentAt} · no answer yet</span>
            </>
          )}
          <Link href={job.href} className="text-[13px] font-semibold text-accent hover:text-accent-strong">Open job</Link>
        </div>
      )}
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 text-sm">
        <span className="text-xs font-bold tracking-[0.08em] text-muted">HISTORY</span>
        {thread.history.map((h, i) => (
          <div key={i} className="flex justify-between gap-2">
            <span className="truncate">{h.label}</span>
            <span className="shrink-0 text-muted">{h.when}</span>
          </div>
        ))}
        <div className="flex justify-between gap-2">
          <span>Texts</span>
          <span className="text-muted">{thread.texts}</span>
        </div>
      </div>
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
        <Link href="/app/bookings/new" className="flex h-10 items-center justify-center rounded-lg border border-border text-sm font-semibold hover:bg-background">Book a visit</Link>
        <span className={`flex items-center gap-1.5 text-xs ${thread.conversation.optedOut ? "text-danger" : "text-ok"}`}>
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${thread.conversation.optedOut ? "bg-danger" : "bg-ok"}`} />
          {thread.conversation.optedOut ? "Opted out" : "Texts allowed"}
        </span>
      </div>
    </aside>
  );
}
