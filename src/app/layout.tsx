import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, Geist_Mono, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// Condensed caps for labels like the findings recommendation meter.
const condensed = Barlow_Condensed({ variable: "--font-barlow-condensed", subsets: ["latin"], weight: ["700", "800"] });

export const metadata: Metadata = {
  title: { default: "Biktrix Pickups", template: "%s · Biktrix Pickups" },
  description: "Book your Biktrix showroom pickup.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-CA" suppressHydrationWarning className={`${inter.variable} ${geistMono.variable} ${condensed.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
