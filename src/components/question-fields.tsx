import { Field } from "@/components/ui";
import { answerField, type BookingQuestion } from "@/lib/booking-questions";

/** A visit type's booking-form questions, on the customer's and the staff booking forms. */
export function QuestionFields({ questions, idPrefix }: { questions: BookingQuestion[]; idPrefix: string }) {
  return (
    <>
      {questions.map((q) => {
        const id = `${idPrefix}_${q.id}`;
        const label = q.required ? q.label : `${q.label} (optional)`;
        return (
          <Field key={q.id} label={label} htmlFor={id}>
            {q.kind === "choice" ? (
              <select id={id} name={answerField(q)} required={q.required} defaultValue="" className="input">
                <option value="" disabled={q.required}>Choose…</option>
                {q.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : q.kind === "long" ? (
              <textarea id={id} name={answerField(q)} required={q.required} rows={3} maxLength={2000} className="input" />
            ) : (
              <input id={id} name={answerField(q)} required={q.required} maxLength={300} className="input" />
            )}
          </Field>
        );
      })}
    </>
  );
}
