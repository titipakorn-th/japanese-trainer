import type { Metadata, Viewport } from "next";
import { PwaBootstrap } from "@/client/PwaBootstrap";
import "./globals.css";
import "./session.css";

/**
 * The metadata is also the install instructions.
 *
 * A learner who adds this to a home screen is doing it to practise without
 * remembering a URL, so the app has to present itself as one app: its own name
 * and icon, no browser chrome, and a background that matches the interface
 * rather than flashing white on open. `manifest.webmanifest` covers the modern
 * browsers; the `appleWebApp` block is the equivalent for iOS, which reads those
 * meta tags instead of the manifest and which is half the "Mac and phone" half
 * of the promise in issue #11.
 */
export const metadata: Metadata = {
  title: "Japanese Trainer",
  description: "A text-first Japanese conversation trainer. Practice real speaking, one short scene at a time.",
  applicationName: "Japanese Trainer",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "日本語",
    // Lets the app paint under the status bar on a notched phone rather than
    // starting below it, which would leave a band of empty background.
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0d10",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        {children}
        <PwaBootstrap />
      </body>
    </html>
  );
}
