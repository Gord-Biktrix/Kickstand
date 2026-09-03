import { describe, expect, it } from "vitest";
import { parseCsv, validateImport } from "@/lib/csv";
import { normalizePhone } from "@/lib/phone";
import { DEFAULT_SETTINGS, validateSettings } from "@/lib/settings";
import { defaultTermsVersion } from "@/lib/units";

const HEADER = "order_ref,source,customer_name,customer_email,customer_phone,model,size,colour,order_date,payment_status,balance_cents,notes";

describe("csv import (Appendix A)", () => {
  it("parses quoted fields", () => {
    expect(parseCsv('a,"b,c","d ""e"""\n1,2,3\n')).toEqual([["a", "b,c", 'd "e"'], ["1", "2", "3"]]);
  });

  it("accepts the spec sample and normalises phones", () => {
    const text = `${HEADER}
LS-48213,lightspeed,Jane Doe,jane@example.com,6045550123,Juggernaut Ultra Beast 2,Regular,Matte Black,2026-06-14,deposit,125000,wants rack installed
SH-100421,shopify,Sam Lee,sam@example.com,+17785550199,Swift Step-Thru,One size,Sage,2026-07-02,paid,0,`;
    const r = validateImport(text, new Set());
    expect(r.errors).toEqual([]);
    expect(r.valid).toHaveLength(2);
    expect(r.valid[0].input.customerPhone).toBe("+16045550123");
    expect(r.valid[0].input.termsVersion).toBe(1);
    expect(r.valid[1].input.balanceCents).toBe(0);
  });

  it("reports row-level errors and duplicates", () => {
    const text = `${HEADER}
X1,ebay,Jo,jo@example.com,,Model,,,2026-1-1,paid,abc,
LS-48213,lightspeed,Jane,jane@example.com,,Model,,,2026-06-14,deposit,0,
LS-48213,lightspeed,Jane,jane@example.com,,Model,,,2026-06-14,deposit,0,`;
    const r = validateImport(text, new Set(["lightspeed:LS-48213"]));
    expect(r.valid).toHaveLength(0);
    expect(r.errors.map((e) => e.row)).toEqual([2, 3, 4]);
    expect(r.errors[0].message).toMatch(/source/);
    expect(r.errors[0].message).toMatch(/order_date/);
    expect(r.errors[0].message).toMatch(/balance_cents/);
    expect(r.errors[1].message).toMatch(/duplicate of existing/);
    expect(r.errors[2].message).toMatch(/duplicate/);
  });
});

describe("phone", () => {
  it("normalises to E.164", () => {
    expect(normalizePhone("(604) 555-0123")).toBe("+16045550123");
    expect(normalizePhone("1 604 555 0123")).toBe("+16045550123");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("12345")).toBeNull();
  });
});

describe("settings", () => {
  it("validates cross-field rules", () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual([]);
    expect(validateSettings({ ...DEFAULT_SETTINGS, booking_horizon_days: 20 })).toContain(
      "Booking horizon must be at least the pick-up-by period.",
    );
    expect(validateSettings({ ...DEFAULT_SETTINGS, min_lead_hours: 0.25 })).toHaveLength(1);
  });

  it("terms version defaults from the effective date (R18)", () => {
    expect(defaultTermsVersion(DEFAULT_SETTINGS, "2026-09-10")).toBe(1);
    const s = { ...DEFAULT_SETTINGS, terms_v2_effective_date: "2026-09-10" };
    expect(defaultTermsVersion(s, "2026-09-09")).toBe(1);
    expect(defaultTermsVersion(s, "2026-09-10")).toBe(2);
  });
});
