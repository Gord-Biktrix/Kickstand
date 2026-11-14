import { describe, expect, it } from "vitest";
import { collectAnswers, readQuestions, SUGGESTED_CALL_QUESTIONS, validateQuestions } from "@/lib/booking-questions";
import { bookingSlackMessage } from "@/lib/slack";

const fail = (m: string): never => { throw new Error(m); };

describe("booking form questions", () => {
  it("validates what managers save", () => {
    const q = validateQuestions([{ id: "topic", label: " Why? ", kind: "choice", options: ["A", " B ", "A", ""], required: true }, { label: "Bike", kind: "text" }]);
    expect(q).toEqual([
      { id: "topic", label: "Why?", kind: "choice", options: ["A", "B"], required: true },
      { id: "q2", label: "Bike", kind: "text", options: [], required: false },
    ]);
    expect(() => validateQuestions([{ label: "", kind: "text" }])).toThrow(/needs some text/);
    expect(() => validateQuestions([{ label: "Pick", kind: "choice", options: ["only one"] }])).toThrow(/two choices/);
    expect(() => validateQuestions(null)).toThrow();
    expect(validateQuestions([{ id: "x", label: "One" }, { id: "x", label: "Two" }]).map((x) => x.id)).toEqual(["x", "x_2"]);
  });

  it("reads stored questions leniently", () => {
    expect(readQuestions([{ id: "a", label: "Ok", kind: "text" }, { id: "b", label: "Bad", kind: "nope" }, "junk"]).map((q) => q.id)).toEqual(["a"]);
    expect(readQuestions(null)).toEqual([]);
  });

  it("collects answers, enforcing required ones and the listed choices", () => {
    const form = (v: Record<string, string>) => (f: string) => v[f] ?? "";
    expect(collectAnswers(SUGGESTED_CALL_QUESTIONS, form({ q_topic: "Financing", q_bikes: " Juggernaut " }), fail)).toEqual([
      { question: "What would you like to talk about?", answer: "Financing" },
      { question: "Which bike(s) are you interested in?", answer: "Juggernaut" },
    ]);
    // Optional and empty: left out.
    expect(collectAnswers(SUGGESTED_CALL_QUESTIONS, form({ q_topic: "Financing" }), fail)).toHaveLength(1);
    expect(() => collectAnswers(SUGGESTED_CALL_QUESTIONS, form({}), fail)).toThrow(/Please answer/);
    expect(() => collectAnswers(SUGGESTED_CALL_QUESTIONS, form({ q_topic: "Made up" }), fail)).toThrow(/pick an answer/);
  });

  it("builds the Slack ping with answers, note and contact links", () => {
    const m = bookingSlackMessage({ kind: "new", store: "Biktrix Online", type: "Sales call", when: "Mon 16 Nov, 9:30 am–10:00 am", customer: "Shawn <b>", phone: "+16045550101", email: "s@example.com", answers: [{ question: "Why?", answer: "Financing" }], note: "Call after 9", url: "https://k.example/app/bookings/1" });
    const text = (m.blocks![0] as { text: { text: string } }).text.text;
    expect(text).toContain("*📅 New booking: Sales call* · Biktrix Online");
    expect(text).toContain("Shawn &lt;b&gt;");
    expect(text).toContain("<tel:+16045550101|+16045550101>");
    expect(text).toContain("*Why?* Financing");
    expect(text).toContain("*Note:* Call after 9");
    expect(text).toContain("<https://k.example/app/bookings/1|Open in Kickstand>");
  });
});
