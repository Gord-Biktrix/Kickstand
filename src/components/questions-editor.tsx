"use client";

import { useState } from "react";
import { MAX_QUESTIONS, QUESTION_KINDS, SUGGESTED_CALL_QUESTIONS, SUGGESTED_SERVICE_QUESTIONS, type BookingQuestion, type QuestionKind } from "@/lib/booking-questions";

type Draft = BookingQuestion & { optionsText: string };

const toDraft = (q: BookingQuestion): Draft => ({ ...q, optionsText: q.options.join("\n") });
let counter = 0;
const newId = () => `q${Date.now().toString(36)}${(counter++).toString(36)}`;

/**
 * The booking form's questions for a visit type, edited in the side panel and saved with it (as JSON in a
 * hidden "questions" field). The customer's name, email, phone and note are always asked; these come after.
 */
export function QuestionsEditor({ initial }: { initial: BookingQuestion[] }) {
  const [list, setList] = useState<Draft[]>(initial.map(toDraft));
  const set = (i: number, patch: Partial<Draft>) => setList((l) => l.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const move = (i: number, d: -1 | 1) => setList((l) => {
    const j = i + d;
    if (j < 0 || j >= l.length) return l;
    const next = [...l];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const value = JSON.stringify(list.map(({ optionsText, ...q }) => ({ ...q, options: q.kind === "choice" ? optionsText.split("\n").map((o) => o.trim()).filter(Boolean) : [] })));

  return (
    <div className="space-y-3">
      <input type="hidden" name="questions" value={value} />
      {list.length === 0 && <p className="text-sm text-muted">Only name, contact details and a note are asked.</p>}
      {list.map((q, i) => (
        <div key={q.id} className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold tracking-wider text-muted uppercase">Question {i + 1}</span>
            <span className="flex gap-1">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" className="btn btn-sm px-2 disabled:opacity-40">↑</button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === list.length - 1} aria-label="Move down" className="btn btn-sm px-2 disabled:opacity-40">↓</button>
              <button type="button" onClick={() => setList((l) => l.filter((_, j) => j !== i))} aria-label={`Remove question ${i + 1}`} className="btn btn-sm px-2 text-red-700">Remove</button>
            </span>
          </div>
          <input aria-label={`Question ${i + 1}`} value={q.label} onChange={(e) => set(i, { label: e.target.value })} placeholder="e.g. What would you like to talk about?" maxLength={200} className="input" />
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <select aria-label="Answer type" value={q.kind} onChange={(e) => set(i, { kind: e.target.value as QuestionKind })} className="input w-auto">
              {QUESTION_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
            <label className="flex items-center gap-2"><input type="checkbox" checked={q.required} onChange={(e) => set(i, { required: e.target.checked })} className="h-4 w-4" /> Required</label>
          </div>
          {q.kind === "choice" && (
            <label className="block text-sm">
              <span className="mb-1 block text-xs text-muted">Choices, one per line</span>
              <textarea value={q.optionsText} onChange={(e) => set(i, { optionsText: e.target.value })} rows={4} className="input" />
            </label>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {list.length < MAX_QUESTIONS && (
          <button type="button" onClick={() => setList((l) => [...l, { id: newId(), label: "", kind: "text", options: [], optionsText: "", required: false }])} className="btn btn-sm">+ Add a question</button>
        )}
        {list.length === 0 && (
          <>
            <button type="button" onClick={() => setList(SUGGESTED_CALL_QUESTIONS.map(toDraft))} className="btn btn-sm">Use the sales-call questions</button>
            <button type="button" onClick={() => setList(SUGGESTED_SERVICE_QUESTIONS.map(toDraft))} className="btn btn-sm">Use the service questions (which bike)</button>
          </>
        )}
      </div>
    </div>
  );
}
