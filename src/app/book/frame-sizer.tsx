"use client";

import { useEffect } from "react";

/**
 * Inside the website embed (an iframe from /embed.js), hide our own header and tell the parent page how tall
 * the content is, so the iframe grows with it. Does nothing on the full page.
 */
export function FrameSizer() {
  useEffect(() => {
    if (window.parent === window) return;
    document.documentElement.classList.add("in-embed");
    const post = () => window.parent.postMessage({ type: "biktrix-booking:height", height: document.documentElement.scrollHeight }, "*");
    const ro = new ResizeObserver(post);
    ro.observe(document.body);
    post();
    return () => ro.disconnect();
  }, []);
  return null;
}
