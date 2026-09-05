import { describe, expect, it } from "vitest";
import { KlaviyoNotifier } from "@/lib/notifier";

function fakeFetch(calls: { url: string; body: Record<string, unknown> }[], status = 202) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status });
  }) as typeof fetch;
}

describe("KlaviyoNotifier", () => {
  it("registers transactional SMS consent once per number, then fires the event", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const n = new KlaviyoNotifier("key", "2025-07-15", fakeFetch(calls));
    const profile = { email: "jo@x.ca", phone: "+16045550123", name: "Jo Rider", smsConsent: true };
    await n.send("Pickup: Booked", profile, { slot_start_local: "Sat" }, "u1:msg_booked:a1");
    expect(calls.map((c) => c.url)).toEqual([
      "https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs",
      "https://a.klaviyo.com/api/events",
    ]);
    const sub = calls[0].body as { data: { attributes: { profiles: { data: { attributes: Record<string, unknown> }[] } } } };
    expect(sub.data.attributes.profiles.data[0].attributes).toMatchObject({
      phone_number: "+16045550123",
      email: "jo@x.ca",
      subscriptions: { sms: { transactional: { consent: "SUBSCRIBED" } } },
    });
    const ev = calls[1].body as { data: { attributes: { metric: { data: { attributes: { name: string } } }; profile: { data: { attributes: Record<string, unknown> } } } } };
    expect(ev.data.attributes.metric.data.attributes.name).toBe("Pickup: Booked");
    expect(ev.data.attributes.profile.data.attributes).toMatchObject({ phone_number: "+16045550123", first_name: "Jo", last_name: "Rider" });

    // Same number again: consent is cached, only the event goes out.
    await n.send("Pickup: Reminder Day Before", profile, {}, "u1:msg_reminder:2026-09-07");
    expect(calls.filter((c) => c.url.endsWith("/events"))).toHaveLength(2);
    expect(calls.filter((c) => c.url.includes("subscription"))).toHaveLength(1);
  });

  it("does not register consent without a phone or without the tick, and still sends the event", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const n = new KlaviyoNotifier("key", "2025-07-15", fakeFetch(calls));
    await n.send("Pickup: Booked", { email: "a@x.ca", phone: "+16045550999", smsConsent: false }, {}, "u2:msg_booked:a2");
    await n.send("Pickup: Booked", { email: "b@x.ca", phone: null, smsConsent: true }, {}, "u3:msg_booked:a3");
    expect(calls.map((c) => c.url)).toEqual(["https://a.klaviyo.com/api/events", "https://a.klaviyo.com/api/events"]);
  });
});
