import { logger } from "./logger";

export type Profile = {
  email: string | null;
  phone: string | null;
  name?: string | null;
  smsConsent: boolean;
};

export interface Notifier {
  /** Fire one metric on one profile. Must throw on final failure. */
  send(
    metric: string,
    profile: Profile,
    properties: Record<string, unknown>,
    uniqueId: string,
  ): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Phone numbers whose SMS consent this process has already registered — avoids a call per message. */
const consentRegistered = new Set<string>();

/** Klaviyo Create Event API. Flows own templates and channel; Kickstand registers SMS consent. */
export class KlaviyoNotifier implements Notifier {
  constructor(
    private apiKey: string,
    private revision: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private headers() {
    return {
      Authorization: `Klaviyo-API-Key ${this.apiKey}`,
      revision: this.revision,
      "Content-Type": "application/vnd.api+json",
      Accept: "application/vnd.api+json",
    };
  }

  /**
   * Klaviyo will not text a number without recorded consent, whatever the flow says. The customer
   * ticked "agrees to text reminders" at the counter or on the booking page, so register that as
   * SMS *transactional* consent (pickup notices about their own order — not marketing). Flow
   * messages must be marked transactional in Klaviyo to reach these profiles. Best-effort: a
   * failure here is logged and the event still goes out (email flows still work).
   */
  private async registerSmsConsent(profile: Profile) {
    if (!profile.phone || !profile.smsConsent || consentRegistered.has(profile.phone)) return;
    const attrs: Record<string, unknown> = {
      phone_number: profile.phone,
      subscriptions: { sms: { transactional: { consent: "SUBSCRIBED" } } },
    };
    if (profile.email) attrs.email = profile.email;
    const body = {
      data: {
        type: "profile-subscription-bulk-create-job",
        attributes: { historical_import: false, profiles: { data: [{ type: "profile", attributes: attrs }] } },
      },
    };
    try {
      const res = await this.fetchImpl("https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs", {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
      if (res.ok) consentRegistered.add(profile.phone);
      else logger.warn({ status: res.status }, "klaviyo: sms consent not registered");
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "klaviyo: sms consent not registered");
    }
  }

  async send(metric: string, profile: Profile, properties: Record<string, unknown>, uniqueId: string) {
    await this.registerSmsConsent(profile);
    const profileAttrs: Record<string, unknown> = { properties: { sms_consent: profile.smsConsent } };
    if (profile.email) profileAttrs.email = profile.email;
    if (profile.phone) profileAttrs.phone_number = profile.phone;
    if (profile.name) {
      const [first, ...rest] = profile.name.split(" ");
      profileAttrs.first_name = first;
      if (rest.length) profileAttrs.last_name = rest.join(" ");
    }
    const body = {
      data: {
        type: "event",
        attributes: {
          properties,
          unique_id: uniqueId,
          metric: { data: { type: "metric", attributes: { name: metric } } },
          profile: { data: { type: "profile", attributes: profileAttrs } },
        },
      },
    };
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchImpl("https://a.klaviyo.com/api/events", {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
        });
        if (res.ok) return;
        lastError = new Error(`Klaviyo ${res.status}`);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
      } catch (err) {
        lastError = err;
      }
      await sleep(500 * 3 ** attempt);
    }
    throw lastError ?? new Error("Klaviyo send failed");
  }
}

export class ConsoleNotifier implements Notifier {
  async send(metric: string, profile: Profile, properties: Record<string, unknown>, uniqueId: string) {
    logger.info(
      { metric, uniqueId, hasEmail: !!profile.email, hasPhone: !!profile.phone, keys: Object.keys(properties) },
      "notifier (console) send",
    );
  }
}

export class MemoryNotifier implements Notifier {
  sent: { metric: string; profile: Profile; properties: Record<string, unknown>; uniqueId: string }[] = [];
  failNext = 0;
  async send(metric: string, profile: Profile, properties: Record<string, unknown>, uniqueId: string) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("simulated failure");
    }
    this.sent.push({ metric, profile, properties, uniqueId });
  }
}

let override: Notifier | null = null;

export function setNotifier(n: Notifier | null) {
  override = n;
}

export function getNotifier(): Notifier {
  if (override) return override;
  const key = process.env.KLAVIYO_PRIVATE_KEY;
  if (key) return new KlaviyoNotifier(key, process.env.KLAVIYO_REVISION ?? "2025-07-15");
  return new ConsoleNotifier();
}
