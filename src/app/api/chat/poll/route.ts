import type { NextRequest } from "next/server";
import { db } from "@/db/client";
import { getCurrentUser } from "@/lib/auth";
import { unreadCount } from "@/lib/chat";
import { listThreads, loadThread, type ThreadFilter } from "@/lib/chat-view";
import { currentShowroom } from "@/lib/current-showroom";

/** The Messages screen polls this every few seconds: the thread list, the open thread, the unread count. */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  const showroom = await currentShowroom(user);
  const sp = request.nextUrl.searchParams;
  const f = sp.get("f");
  const filter: ThreadFilter = f === "unread" || f === "ok" ? f : "all";
  const c = sp.get("c");
  const [threads, thread, unread] = await Promise.all([
    sp.get("threads") === "0" ? Promise.resolve(null) : listThreads(db, showroom, { q: sp.get("q") ?? "", filter }),
    c ? loadThread(db, showroom, c) : Promise.resolve(null),
    unreadCount(db, showroom.id),
  ]);
  return Response.json({ threads, thread, unread }, { headers: { "Cache-Control": "no-store" } });
}
