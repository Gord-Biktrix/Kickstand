import { normalizePhone } from "./phone";
import type { OrderInput } from "./units";

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF/LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

export const IMPORT_COLUMNS = [
  "order_ref",
  "source",
  "customer_name",
  "customer_email",
  "customer_phone",
  "model",
  "size",
  "colour",
  "order_date",
  "payment_status",
  "balance_cents",
  "notes",
] as const;

export type ImportRowError = { row: number; message: string };
export type ImportResult = { valid: { row: number; input: OrderInput }[]; errors: ImportRowError[] };

/** Appendix A validation. `existingRefs` = "source:order_ref" already in the showroom. */
export function validateImport(text: string, existingRefs: Set<string>): ImportResult {
  const rows = parseCsv(text);
  const errors: ImportRowError[] = [];
  const valid: ImportResult["valid"] = [];
  if (rows.length === 0) return { valid, errors: [{ row: 0, message: "File is empty" }] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const missing = IMPORT_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    return { valid, errors: [{ row: 1, message: `Missing columns: ${missing.join(", ")}` }] };
  }
  const idx = (name: (typeof IMPORT_COLUMNS)[number]) => header.indexOf(name);
  const seen = new Set<string>();
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const get = (name: (typeof IMPORT_COLUMNS)[number]) => (cells[idx(name)] ?? "").trim();
    const rowNo = r + 1;
    const problems: string[] = [];
    const orderRef = get("order_ref");
    const source = get("source").toLowerCase();
    const paymentStatus = get("payment_status").toLowerCase();
    const orderDate = get("order_date");
    const balanceRaw = get("balance_cents");
    const phoneRaw = get("customer_phone");
    const email = get("customer_email");

    if (!orderRef) problems.push("order_ref is required");
    if (!["lightspeed", "shopify", "manual"].includes(source)) problems.push("source must be lightspeed, shopify or manual");
    if (!get("customer_name")) problems.push("customer_name is required");
    if (!get("model")) problems.push("model is required");
    if (!["paid", "deposit"].includes(paymentStatus)) problems.push("payment_status must be paid or deposit");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate) || Number.isNaN(Date.parse(orderDate))) problems.push("order_date must be ISO (YYYY-MM-DD)");
    const balance = balanceRaw === "" ? 0 : Number(balanceRaw);
    if (!Number.isInteger(balance) || balance < 0) problems.push("balance_cents must be a non-negative integer");
    const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
    if (phoneRaw && !phone) problems.push("customer_phone could not be normalised to E.164");
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.push("customer_email is invalid");
    if (!email && !phone) problems.push("customer_email or customer_phone is required");
    const key = `${source}:${orderRef}`;
    if (existingRefs.has(key)) problems.push(`duplicate of existing order ${orderRef} (${source})`);
    else if (seen.has(key)) problems.push(`duplicate of another row in this file (${orderRef})`);
    seen.add(key);

    if (problems.length) {
      errors.push({ row: rowNo, message: problems.join("; ") });
      continue;
    }
    valid.push({
      row: rowNo,
      input: {
        orderRef,
        source: source as OrderInput["source"],
        customerName: get("customer_name"),
        customerEmail: email || null,
        customerPhone: phone,
        model: get("model"),
        size: get("size") || null,
        colour: get("colour") || null,
        orderDate,
        paymentStatus: paymentStatus as OrderInput["paymentStatus"],
        balanceCents: balance,
        termsVersion: 1,
        notes: get("notes") || null,
      },
    });
  }
  return { valid, errors };
}
