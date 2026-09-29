import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { SITE_URL } from "@/lib/siteUrl";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Reel Creator", template: "%s | Reel Creator" },
  description: "Turn your photos and clips into a share-ready video reel, for any business.",
};

// Organization structured data -- site-wide (every page includes RootLayout),
// unlike the homepage's own SoftwareApplication JSON-LD (what the PRODUCT
// is), this is about who publishes it, so an AI/search engine resolving
// "who makes this" or "is this a real company" has something to point at.
// No `sameAs` (social profiles) -- there are none yet; a fabricated one
// would be worse than none.
const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Reel Creator",
  url: SITE_URL,
  logo: `${SITE_URL}/apple-icon.png`,
};

// Lets full-bleed pages (CameraCapturePage's `env(safe-area-inset-*)`
// padding, so its floating controls clear a notched phone's status bar/home
// indicator) actually draw under the notch instead of Safari reserving a
// plain black bar there with those env() vars all resolving to 0. Additive
// site-wide -- no other page reads those vars today.
export const viewport: Viewport = {
  viewportFit: "cover",
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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
