import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./session.css";

export const metadata: Metadata = {
  title: "japanese-trainer",
  description: "A text-first Japanese conversation trainer.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
