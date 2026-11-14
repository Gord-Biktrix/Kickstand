/**
 * Questions a visit type asks on its booking form (like YouCanBookMe's booking form), and the customer's
 * answers. Questions live on the type as JSON; each booking keeps a copy of the questions it was asked with
 * the answers, so editing a type later never changes what an old booking says.
 */
export type QuestionKind = "text" | "long" | "choice";
export type BookingQuestion = { id: string; label: string; kind: QuestionKind; options: string[]; required: boolean };
export type BookingAnswer = { question: string; answer: string };

export const QUESTION_KINDS: { key: QuestionKind; label: string }[] = [
  { key: "text", label: "Short answer" },
  { key: "long", label: "Paragraph" },
  { key: "choice", label: "Pick one" },
];

export const MAX_QUESTIONS = 10;
const KINDS = new Set<QuestionKind>(["text", "long", "choice"]);

/** Starting point for a sales or expert call (the old YCBM booking form). */
export const SUGGESTED_CALL_QUESTIONS: BookingQuestion[] = [
  { id: "topic", label: "What would you like to talk about?", kind: "choice", options: ["Choosing a bike", "An order or delivery", "Financing", "Something else"], required: true },
  { id: "bikes", label: "Which bike(s) are you interested in?", kind: "text", options: [], required: false },
];

/** Lenient read of what's stored on a type: drops anything malformed rather than breaking the booking page. */
export function readQuestions(raw: unknown): BookingQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q) => {
    if (!q || typeof q !== "object") return [];
    const { id, label, kind, options, required } = q as Record<string, unknown>;
    if (typeof id !== "string" || typeof label !== "string" || !KINDS.has(kind as QuestionKind)) return [];
    const opts = Array.isArray(options) ? options.filter((o): o is string => typeof o === "string") : [];
    if (kind === "choice" && opts.length < 2) return [];
    return [{ id, label, kind: kind as QuestionKind, options: kind === "choice" ? opts : [], required: required === true }];
  });
}

export function readAnswers(raw: unknown): BookingAnswer[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is BookingAnswer => !!a && typeof a === "object" && typeof (a as BookingAnswer).question === "string" && typeof (a as BookingAnswer).answer === "string");
}

/** Strict check of what a manager saves in the editor. Throws a message for them. */
export function validateQuestions(raw: unknown): BookingQuestion[] {
  if (!Array.isArray(raw)) throw new Error("The booking questions couldn't be read. Please try again.");
  if (raw.length > MAX_QUESTIONS) throw new Error(`Ask at most ${MAX_QUESTIONS} questions.`);
  const seen = new Set<string>();
  return raw.map((q, i) => {
    const r = (q ?? {}) as Record<string, unknown>;
    const label = String(r.label ?? "").trim();
    if (!label) throw new Error(`Question ${i + 1} needs some text.`);
    if (label.length > 200) throw new Error(`Keep question ${i + 1} under 200 characters.`);
    const kind = KINDS.has(r.kind as QuestionKind) ? (r.kind as QuestionKind) : "text";
    const options = kind === "choice" ? [...new Set((Array.isArray(r.options) ? r.options : []).map((o) => String(o).trim()).filter(Boolean))].slice(0, 12) : [];
    if (kind === "choice" && options.length < 2) throw new Error(`“${label}” needs at least two choices, one per line.`);
    let id = String(r.id ?? "").replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || `q${i + 1}`;
    while (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    return { id, label, kind, options, required: r.required === true };
  });
}

/** The form field a question's answer comes back in. */
export const answerField = (q: Pick<BookingQuestion, "id">) => `q_${q.id}`;

/**
 * The customer's answers, checked against the questions. `get` reads a submitted form field. Throws
 * `{ question }`-style messages via `fail` (the caller turns them into its own error type).
 */
export function collectAnswers(questions: BookingQuestion[], get: (field: string) => string, fail: (message: string) => never): BookingAnswer[] {
  return questions.flatMap((q) => {
    const answer = get(answerField(q)).trim().slice(0, q.kind === "long" ? 2000 : 300);
    if (!answer) {
      if (q.required) fail(`Please answer “${q.label}”.`);
      return [];
    }
    if (q.kind === "choice" && !q.options.includes(answer)) fail(`Please pick an answer for “${q.label}”.`);
    return [{ question: q.label, answer }];
  });
}
