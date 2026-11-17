"use client";

/**
 * Drag and drop on the Workshop board. Cards (server-rendered) carry data-job, data-unit and data-moves (the
 * columns they can go to); columns carry data-col. A drop does what the card's own button would:
 * a repair writes the column's Lightspeed status (moveJobAction), Ready opens the confirm panel so staff choose
 * whether the customer is told, and a bike for pickup goes Build → Ready (Kickstand only). The buttons stay for
 * anyone who'd rather tap.
 */
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { markReadyAction, moveJobAction, startBuildAction } from "@/app/app/actions";
import type { BoardColumn } from "@/lib/workshop-columns";

const CAN_DROP = ["outline-2", "outline-dashed", "outline-[#ff6b1a]", "-outline-offset-2"];
const OVER = ["bg-[#ffe7d6]"];

export function BoardDnd({ back, children }: { back: string; children: React.ReactNode }) {
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ card: HTMLElement; job: string; unit: string; from: string; moves: string[] } | null>(null);
  // The card being saved: dimmed while the move (and the page refresh after it) is under way.
  const [moving, setMoving] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const busy = pending ? moving : null;

  const columns = () => [...(root.current?.querySelectorAll<HTMLElement>("[data-col]") ?? [])];
  const clear = () => {
    for (const c of columns()) c.classList.remove(...CAN_DROP, ...OVER);
    drag.current?.card.classList.remove("opacity-40");
  };
  const target = (e: React.DragEvent) => {
    const col = (e.target as HTMLElement).closest<HTMLElement>("[data-col]");
    return col && drag.current?.moves.includes(col.dataset.col!) ? col : null;
  };

  return (
    <div
      ref={root}
      className={busy ? "cursor-progress" : undefined}
      onDragStart={(e) => {
        const card = (e.target as HTMLElement).closest<HTMLElement>("[data-job]");
        const moves = card?.dataset.moves?.split(",").filter(Boolean) ?? [];
        if (!card || !moves.length || busy) return e.preventDefault();
        drag.current = { card, job: card.dataset.job!, unit: card.dataset.unit ?? "", from: card.closest<HTMLElement>("[data-col]")?.dataset.col ?? "", moves };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", card.dataset.job!);
        requestAnimationFrame(() => {
          card.classList.add("opacity-40");
          for (const c of columns()) if (moves.includes(c.dataset.col!)) c.classList.add(...CAN_DROP);
        });
      }}
      onDragOver={(e) => {
        const col = target(e);
        if (!col) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        for (const c of columns()) c.classList.toggle(OVER[0], c === col);
      }}
      onDragLeave={(e) => {
        const col = (e.target as HTMLElement).closest<HTMLElement>("[data-col]");
        if (col && !col.contains(e.relatedTarget as Node)) col.classList.remove(...OVER);
      }}
      onDragEnd={() => {
        clear();
        drag.current = null;
      }}
      onDrop={(e) => {
        const col = target(e);
        const d = drag.current;
        clear();
        drag.current = null;
        if (!col || !d) return;
        e.preventDefault();
        const to = col.dataset.col as BoardColumn;
        if (d.unit) {
          setMoving(d.job);
          start(async () => {
            await (to === "doing" ? startBuildAction(d.unit, back) : markReadyAction(d.unit, back));
          });
          return;
        }
        if (to === "ready") {
          router.push(`${back}${back.includes("?") ? "&" : "?"}ready=${encodeURIComponent(d.job)}`);
          return;
        }
        setMoving(d.job);
        start(async () => {
          await moveJobAction(d.job, to, back);
        });
      }}
    >
      {busy && <style>{`[data-job="${CSS.escape(busy)}"]{opacity:.45;pointer-events:none}`}</style>}
      {children}
    </div>
  );
}
