import type { Metadata } from "next";
import "./globals.css";

const SITE_URL = "https://video-editing-tool-gamma.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Timeline Editor", template: "%s | Timeline Editor" },
  description: "Turn your photos and clips into a share-ready video reel, for any business.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
