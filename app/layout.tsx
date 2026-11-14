import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WebNest — Lead Finder",
  description: "Find, audit and export potential web-design clients for BUILDORA.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
