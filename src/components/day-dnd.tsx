"use client";

/**
 * Drag and drop on the Workshop's Day view: a block (data-job, data-lane = its mechanic) dropped on another lane
 * (data-lane = a Lightspeed employee id, "" = Unassigned) gives the job to that mechanic. Only Lightspeed work
 * orders can be reassigned (data-assignable). The block dims while Lightspeed saves.
 */
import { useRef, useState, useTransition } from "react";
import { assignMechanicAction } from "@/app/app/actions";

export function DayDnd({ back, children }: { back: string; children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ job: string; lane: string } | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const busy = pending ? moving : null;
  const lanes = () => [...(root.current?.querySelectorAll<HTMLElement>("[data-lane]:not([data-job])") ?? [])];
  const clear = () => { for (const l of lanes()) l.classList.remove("bg-[#fbfee8]", "outline-2", "outline-dashed", "outline-[#015d47]", "-outline-offset-2"); };
  const laneAt = (e: React.DragEvent) => (e.target as HTMLElement).closest<HTMLElement>("[data-lane]:not([data-job])");

  return (
    <div
      ref={root}
      onDragStart={(e) => {
        const block = (e.target as HTMLElement).closest<HTMLElement>("[data-job]");
        if (!block || block.dataset.assignable !== "1" || busy) return e.preventDefault();
        drag.current = { job: block.dataset.job!, lane: block.dataset.lane ?? "" };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", block.dataset.job!);
      }}
      onDragOver={(e) => {
        const l = laneAt(e);
        if (!l || !drag.current) return;
        e.preventDefault();
        for (const x of lanes()) {
          const on = x === l && x.dataset.lane !== drag.current.lane;
          x.classList.toggle("bg-[#fbfee8]", on);
          x.classList.toggle("outline-2", on);
          x.classList.toggle("outline-dashed", on);
          x.classList.toggle("outline-[#015d47]", on);
          x.classList.toggle("-outline-offset-2", on);
        }
      }}
      onDragEnd={() => { clear(); drag.current = null; }}
      onDrop={(e) => {
        const l = laneAt(e);
        const d = drag.current;
        clear();
        drag.current = null;
        if (!l || !d || l.dataset.lane === d.lane) return;
        e.preventDefault();
        setMoving(d.job);
        start(async () => { await assignMechanicAction(d.job, l.dataset.lane ?? "", back); });
      }}
    >
      {busy && <style>{`[data-job="${CSS.escape(busy)}"]{opacity:.45;pointer-events:none}`}</style>}
      {children}
    </div>
  );
}
