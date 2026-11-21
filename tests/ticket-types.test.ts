import { describe, expect, it } from "vitest";
import { isTicketType, staffBookHref } from "@/lib/booking-types";

const t = { id: "x", kind: "standard", active: true, createsWorkOrder: true, location: "in_person" };

describe("+ New: which types open New ticket", () => {
  it("work-order, in-person types open New ticket set to that type; others the booking form", () => {
    expect(isTicketType(t)).toBe(true);
    expect(staffBookHref(t, "showroom")).toBe("/app/workshop/new?type=x");
    expect(staffBookHref({ ...t, createsWorkOrder: false }, "showroom")).toBe("/app/bookings/new?type=x");
    expect(staffBookHref({ ...t, location: "video" }, "showroom")).toBe("/app/bookings/new?type=x");
    expect(staffBookHref(t, "online")).toBe("/app/bookings/new?type=x");
    expect(isTicketType({ ...t, active: false })).toBe(false);
  });
});
