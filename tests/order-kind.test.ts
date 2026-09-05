import { describe, expect, it } from "vitest";
import { orderKind } from "@/lib/messages";

describe("orderKind (pre-order vs stock)", () => {
  const tz = "America/Vancouver";
  const invitedAt = new Date("2026-09-05T18:00:00Z"); // 5 Sep local
  it("treats a Lightspeed special order as a pre-order however recent", () => {
    expect(orderKind({ invitedAt, receivedAt: invitedAt }, { orderDate: "2026-09-05", lsSaleLineId: "75843" }, tz)).toEqual({ order_kind: "preorder", days_waited: 0 });
  });
  it("treats an order placed days ago as a pre-order and a fresh one as stock", () => {
    expect(orderKind({ invitedAt, receivedAt: invitedAt }, { orderDate: "2026-08-20", lsSaleLineId: null }, tz)).toEqual({ order_kind: "preorder", days_waited: 16 });
    expect(orderKind({ invitedAt, receivedAt: invitedAt }, { orderDate: "2026-09-04", lsSaleLineId: null }, tz)).toEqual({ order_kind: "stock", days_waited: 1 });
  });
  it("is empty without an order", () => {
    expect(orderKind({ invitedAt, receivedAt: invitedAt }, null, tz)).toEqual({ order_kind: "", days_waited: "" });
  });
});
