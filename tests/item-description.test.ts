import { describe, expect, it } from "vitest";
import { splitItemDescription } from "@/lib/lightspeed";

describe("splitItemDescription (Lightspeed item → model / size / colour)", () => {
  it("uses the matrix name as the model and named attributes for the variant", () => {
    expect(splitItemDescription("86-Juggernaut Lite Plus - Limited Edition Green", { Color: "Green" }, "86-Juggernaut Lite Plus - Limited Edition")).toEqual({
      model: "Juggernaut Lite Plus - Limited Edition",
      size: null,
      colour: "Green",
    });
  });

  it("matches Colour/Color and Size attribute names loosely", () => {
    expect(splitItemDescription("12-Stunner Go Blue 19", { Colour: "Blue", Size: "19" }, "12-Stunner Go")).toEqual({ model: "Stunner Go", size: "19", colour: "Blue" });
  });

  it("without a matrix, strips the vendor prefix and trailing variant values from the description", () => {
    expect(splitItemDescription("86-Juggernaut Lite Plus - Limited Edition Green", { Color: "Green" })).toEqual({
      model: "Juggernaut Lite Plus - Limited Edition",
      size: null,
      colour: "Green",
    });
    expect(splitItemDescription("Stunner Go - Blue / 19", { Color: "Blue", Size: "19" })).toEqual({ model: "Stunner Go", size: "19", colour: "Blue" });
  });

  it("falls back to the plain description for a non-matrix item", () => {
    expect(splitItemDescription("Kickstand accessory", {})).toEqual({ model: "Kickstand accessory", size: null, colour: null });
  });
});
