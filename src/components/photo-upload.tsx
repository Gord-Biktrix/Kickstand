"use client";

import { useRef, useState } from "react";

/**
 * Pick a photo: it's cropped to a square and shrunk to 256px in the browser, then the form is sent with it as a
 * JPEG data URL in a hidden "photo" field. Works with any image the browser can open (JPEG, PNG, HEIC on Safari).
 */
export function PhotoUpload({ label = "Add photo" }: { label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const hidden = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function pick(file: File) {
    setBusy(true);
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = () => fail(new Error("unreadable")); img.src = url; });
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
      URL.revokeObjectURL(url);
      hidden.current!.value = canvas.toDataURL("image/jpeg", 0.85);
      hidden.current!.form!.requestSubmit();
    } catch {
      alert("That photo couldn't be opened. Try a JPEG or PNG.");
      setBusy(false);
    }
  }

  return (
    <>
      <input ref={hidden} type="hidden" name="photo" />
      <input ref={input} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
      <button type="button" onClick={() => input.current?.click()} disabled={busy} className="text-xs text-accent underline disabled:opacity-50">{busy ? "Uploading…" : label}</button>
    </>
  );
}
