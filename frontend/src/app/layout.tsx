import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_URL = "https://video-editing-tool-gamma.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Reel Creator", template: "%s | Reel Creator" },
  description: "Turn your photos and clips into a share-ready video reel, for any business.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Applies the saved theme before paint, so there's no flash of the
            default theme. Keep the storage key/shape in sync with
            src/lib/theme.ts and theme-provider.tsx. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var raw=localStorage.getItem("reel-creator-theme");var mode="system",colorTheme="winter";if(raw){var parsed=JSON.parse(raw);mode=parsed.mode||mode;colorTheme=parsed.colorTheme||colorTheme;}var dark=mode==="dark"||(mode!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var root=document.documentElement;root.dataset.colorTheme=colorTheme;root.classList.toggle("dark",dark);}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
