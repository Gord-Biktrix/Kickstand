import { describe, expect, it } from "vitest";
import { summariseMessageTypes } from "@/lib/day-summary";

describe("done for you today", () => {
  it("counts invites, reminders, other messages and failures", () => {
    expect(summariseMessageTypes([
      { type: "msg_bike_arrived", status: "sent", n: 2 },
      { type: "msg_reminder_day_before", status: "sent", n: 3 },
      { type: "booking_reminder_day_before", status: "sent", n: 1 },
      { type: "booking_confirmed", status: "sent", n: 4 },
      { type: "msg_booked", status: "failed", n: 1 },
      { type: "booking_checked_in", status: null, n: 5 },
    ])).toEqual({ invites: 2, reminders: 4, otherMessages: 4, failed: 1 });
  });
});
