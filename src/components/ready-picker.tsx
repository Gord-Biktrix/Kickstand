/** Ready-by label for the New ticket (it is worked out, not picked). */

const pad = (n: number) => String(n).padStart(2, "0");
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Calendar maths on plain "YYYY-MM-DD" strings (no time zones involved). */
function parts(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return { y, m, day };
}
function weekday(d: string) {
  const { y, m, day } = parts(d);
  return new Date(Date.UTC(y, m - 1, day)).getUTCDay();
}
function label12(t: string) {
  const [h, mi] = t.split(":").map(Number);
  return `${h % 12 || 12}:${pad(mi)} ${h < 12 ? "am" : "pm"}`;
}
/** "Mon 16 Nov, 4:00 pm" from "2026-11-16T16:00". */
export function readyLabel(v: string) {
  const [d, t] = v.split("T");
  if (!d || !t) return "";
  const { m, day } = parts(d);
  return `${DAY[weekday(d)]} ${day} ${MONTH[m - 1]}, ${label12(t)}`;
}
