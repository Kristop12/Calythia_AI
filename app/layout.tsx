import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Calythia — Autonomous-agent orb interface",
  description:
    "Calythia: an animated orb + reasoning-graph UI. Hand-written SVG/CSS with a small react-three-fiber particle core.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
