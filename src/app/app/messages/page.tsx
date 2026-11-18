import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { requireUser } from "@/lib/auth";
import { listThreads, loadThread, type ThreadFilter } from "@/lib/chat-view";
import { currentShowroom } from "@/lib/current-showroom";
import { sp, type SearchParams } from "@/lib/flash";
import { formatInZone } from "@/lib/time";
import { Inbox } from "./inbox";

export const metadata = { title: "Messages" };

/** Closing time today, from the store's weekly hours: "6 pm". */
function closesToday(hours: Record<string, [string, string][]>, tz: string): string | null {
  const today = hours[formatInZone(new Date(), tz, "i") === "7" ? "0" : formatInZone(new Date(), tz, "i")] ?? [];
  const end = today.map((r) => r[1]).sort().at(-1);
  if (!end) return null;
  const [h, m] = end.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}

export default async function MessagesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  // Kickstand Chat is v3: off until KICKSTAND_CHAT=on (Twilio isn't live).
  if (process.env.KICKSTAND_CHAT !== "on") notFound();
  const q = await searchParams;
  const user = await requireUser("staff");
  const showroom = await currentShowroom(user);
  const c = sp(q.c) ?? null;
  const search = sp(q.q) ?? "";
  const f = sp(q.f);
  const filter: ThreadFilter = f === "unread" || f === "ok" ? f : "all";
  const [threads, thread] = await Promise.all([listThreads(db, showroom, { q: search, filter }), c ? loadThread(db, showroom, c) : Promise.resolve(null)]);
  return (
    <Inbox
      key={`${c}|${search}|${filter}`}
      initialThreads={threads}
      initialThread={thread}
      selected={thread ? c : null}
      q={search}
      filter={filter}
      closes={closesToday(showroom.bookingHours, showroom.timezone)}
      showNew={sp(q.new) === "1"}
      error={sp(q.error)}
    />
  );
}
