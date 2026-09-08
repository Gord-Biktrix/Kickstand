import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Home-screen icon: the Kickstand tile rendered to PNG at request time (no image tooling in the repo). */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: 180, height: 180, display: "flex", background: "#C2410C", borderRadius: 40 }}>
        <svg width="180" height="180" viewBox="0 0 64 64">
          <g fill="none" stroke="#FAFAFA" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" transform="translate(32 32) scale(0.78) translate(-32 -32)">
            <path d="M18 12V42" /><path d="M18 32L40 12" /><path d="M26 25L46 52" /><path d="M12 52H52" />
          </g>
        </svg>
      </div>
    ),
    size,
  );
}
