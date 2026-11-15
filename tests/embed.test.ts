import { describe, expect, it } from "vitest";
import { INLINE_PLACEHOLDER, embedScript, embedSnippet } from "@/lib/embed-script";

const base = { root: "https://k.example", store: "vancouver", type: "test-ride", text: "Book a test ride", color: "#ff6b1a", textColor: "#17181a" } as const;

describe("embed snippets", () => {
  it("inline", () => {
    expect(embedSnippet({ ...base, how: "inline" })).toBe(`<link rel="preconnect" href="https://k.example">\n<div data-biktrix-booking="vancouver" data-type="test-ride">${INLINE_PLACEHOLDER}</div>\n<script src="https://k.example/embed.js" async></script>`);
    expect(INLINE_PLACEHOLDER).toContain("Loading available times");
  });

  it("whole store leaves out data-type", () => {
    expect(embedSnippet({ ...base, type: null, how: "inline" })).not.toContain("data-type");
    expect(embedSnippet({ ...base, type: null, how: "link" })).toContain('href="https://k.example/book/vancouver"');
  });

  it("popup button carries text and colours", () => {
    const s = embedSnippet({ ...base, how: "button" });
    expect(s).toContain('data-biktrix-popup-button="vancouver"');
    expect(s).toContain('data-text="Book a test ride" data-color="#ff6b1a" data-text-color="#17181a"');
  });

  it("popup link falls back to the booking page without JavaScript, and escapes text", () => {
    const s = embedSnippet({ ...base, how: "link", text: 'Ride "now" <today>' });
    expect(s).toContain('href="https://k.example/book/vancouver/test-ride"');
    expect(s).toContain("Ride &quot;now&quot; &lt;today&gt;</a>");
  });

  it("the script is valid JavaScript and exposes open/close", () => {
    const js = embedScript("https://k.example");
    expect(() => new Function(js)).not.toThrow();
    expect(js).toContain("window.BiktrixBooking={open:open,close:close}");
  });
});
