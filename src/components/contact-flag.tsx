import type { Order } from "@/db/schema";
import { normalizePhone } from "@/lib/phone";

type Contact = Pick<Order, "customerPhone" | "customerEmail">;

/** What stops messages reaching this customer; empty when phone and email are both usable. */
export function contactProblems(o: Contact): string[] {
  const out: string[] = [];
  if (!o.customerPhone) out.push("No phone number");
  else if (!normalizePhone(o.customerPhone)) out.push(`Phone ${o.customerPhone} can't be texted`);
  if (!o.customerEmail) out.push("No email");
  return out;
}

/** A "!" beside the customer's name when the order is missing a phone or email. Hover for which. */
export function ContactFlag({ order }: { order: Contact | null | undefined }) {
  if (!order) return null;
  const problems = contactProblems(order);
  if (problems.length === 0) return null;
  // Neither channel works → nothing reaches them at all.
  const none = !order.customerEmail && !normalizePhone(order.customerPhone);
  const label = problems.join(" · ");
  return (
    <span
      title={label}
      className={`ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full align-middle text-[11px] font-bold leading-none ${none ? "bg-danger text-white" : "bg-warn-soft text-warn ring-1 ring-warn/40"}`}
    >
      !<span className="sr-only"> {label}</span>
    </span>
  );
}
