import { z } from "zod";

export const settingsSchema = z.object({
  slot_minutes: z.number().int().min(5).max(240).default(45),
  min_lead_hours: z.number().min(0).default(48),
  booking_horizon_days: z.number().int().min(1).default(42),
  book_by_days: z.number().int().min(1).default(14),
  pickup_by_days: z.number().int().min(1).default(21),
  reschedule_cutoff_hours: z.number().min(0).default(24),
  extension_days: z.number().int().min(1).default(7),
  storage_fee_enabled: z.boolean().default(false),
  storage_rate_cents: z.number().int().min(0).default(1000),
  storage_cap_cents: z.number().int().min(0).default(15000),
  release_rule_enabled: z.boolean().default(false),
  defer_enabled: z.boolean().default(true),
  early_bird_enabled: z.boolean().default(false),
  early_bird_hours: z.number().min(0).default(72),
  early_bird_reward_text: z
    .string()
    .default("free installation of accessories bought with your bike"),
  reminder_send_hour_local: z.number().int().min(0).max(23).default(17),
  clock_run_hour_local: z.number().int().min(0).max(23).default(7),
  terms_v2_effective_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  clock_last_run_date: z.string().nullable().default(null),
  /**
   * Lightspeed bridge (README "Lightspeed bridge"): when enabled, every customer message
   * also moves the unit's Lightspeed work order to the status mapped for that message, so
   * Ikeono's work-order-status automations send the text from the showroom's own number.
   * `statuses` maps message keys (see metricKey in src/lib/messages.ts) to workorderStatusIDs.
   */
  lightspeed: z
    .object({
      enabled: z.boolean().default(false),
      shop_id: z.number().int().nullable().default(null),
      employee_id: z.number().int().nullable().default(null),
      /** Status a new work order is created in before the first mapped status is applied (Lightspeed's default "Open" is 1). */
      open_status_id: z.number().int().default(1),
      /**
       * What the work order's Due (etaOut) means. "pickup": the customer's slot (Ikeono's {ETA Out}
       * smart field then quotes it). "assembly": the build deadline — `assembly_due_time_local` on the
       * pickup day, or on the previous open day if the slot is earlier than that — and the pickup
       * time rides in Hook Out and the note instead.
       */
      due_mode: z.enum(["pickup", "assembly", "lead"]).default("pickup"),
      assembly_due_time_local: z.string().regex(/^\d{2}:\d{2}$/).default("10:00"),
      /** "lead" mode: build deadline = pickup minus this many working hours (a shop day counts as 8, so 8 = same time on the previous open day). */
      assembly_lead_work_hours: z.number().int().min(1).max(80).default(8),
      statuses: z.record(z.string(), z.number().int()).default({}),
    })
    .default({ enabled: false, shop_id: null, employee_id: null, open_status_id: 1, due_mode: "pickup", assembly_due_time_local: "10:00", assembly_lead_work_hours: 8, statuses: {} }),
});

export type ProgramSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: ProgramSettings = settingsSchema.parse({});

/** Keys a manager may edit; flags are admin-only (see FLAG_KEYS). */
export const PROGRAM_KEYS = [
  "slot_minutes",
  "min_lead_hours",
  "booking_horizon_days",
  "book_by_days",
  "pickup_by_days",
  "reschedule_cutoff_hours",
  "extension_days",
  "storage_rate_cents",
  "storage_cap_cents",
  "early_bird_hours",
  "early_bird_reward_text",
  "reminder_send_hour_local",
  "clock_run_hour_local",
  "terms_v2_effective_date",
] as const satisfies readonly (keyof ProgramSettings)[];

export const FLAG_KEYS = [
  "storage_fee_enabled",
  "release_rule_enabled",
  "defer_enabled",
  "early_bird_enabled",
] as const satisfies readonly (keyof ProgramSettings)[];

export function parseSettings(raw: unknown): ProgramSettings {
  const result = settingsSchema.safeParse(raw ?? {});
  if (result.success) return result.data;
  // Fall back key-by-key so one bad value doesn't take the whole showroom down.
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const single = settingsSchema.pick({ [k]: true } as never).safeParse({ [k]: v });
      if (single.success) merged[k] = v;
    }
  }
  return settingsSchema.parse(merged);
}

/** Cross-field validation from §10.2 settings/program. Returns human-readable errors. */
export function validateSettings(s: ProgramSettings): string[] {
  const errors: string[] = [];
  if (s.booking_horizon_days < s.pickup_by_days) {
    errors.push("Booking horizon must be at least the pick-up-by period.");
  }
  if (s.book_by_days > s.pickup_by_days) {
    errors.push("Book-by days cannot exceed pick-up-by days.");
  }
  if (s.min_lead_hours < s.slot_minutes / 60) {
    errors.push("Minimum lead time must be at least one slot length.");
  }
  if (s.storage_rate_cents < 0 || s.storage_cap_cents < 0) {
    errors.push("Storage rate and cap must be non-negative.");
  }
  return errors;
}
