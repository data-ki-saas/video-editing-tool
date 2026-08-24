import type { Metadata } from "next";
import Link from "next/link";
import { ReelIcon } from "@/components/IconButton";

const SITE_URL = "https://video-editing-tool-gamma.vercel.app";

// Title/description tuned for people searching for what this actually is:
// a video reel maker that works across business types, not a single-niche
// tool -- "for any business" and the explicit niche list both matter for
// matching real search intent (e.g. "auto dealership video maker",
// "real estate listing video generator"). Also covers "Edge Render" (the
// free/local render)'s own search intent ("browser-based video renderer",
// "render video online free no upload", "instant video render") now that
// it's a real, shippable differentiator (no upload/wait for the cloud
// render, no cost) -- see keywords below and the on-page "Edge Render"
// callout further down. The SEO-facing copy still leads with generic terms
// people actually search for ("free"/"browser-based"/"instant") rather than
// the product name itself, which nobody searches for.
export const metadata: Metadata = {
  title: "Video Reel Maker for Any Business — Free Browser-Based Rendering",
  description:
    "Turn your photos and clips into a share-ready video reel — for real estate, hotels, auto dealers, garment and gift shops, hardware stores, or any business. Render instantly right in your browser, free, with no upload or wait. Works on desktop and mobile.",
  keywords: [
    "video reel maker",
    "browser-based video renderer",
    "render video online free",
    "instant video render",
    "no upload video editor",
    "real estate video maker",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    title: "Reel Creator — Video Reel Maker for Any Business",
    description:
      "Turn your photos and clips into a share-ready video reel, for any business niche. Free, instant, browser-based rendering — no upload, no wait. Works on desktop and mobile.",
    url: SITE_URL,
    siteName: "Reel Creator",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Reel Creator — Video Reel Maker for Any Business",
    description:
      "Turn your photos and clips into a share-ready video reel, for any business niche. Free, instant, browser-based rendering.",
  },
};

const EXAMPLE_NICHES = [
  "Real estate",
  "Hotels",
  "Short-term rentals",
  "Auto dealerships",
  "Garment shops",
  "Gift shops",
  "Hardware stores",
];

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Reel Creator",
  applicationCategory: "MultimediaApplication",
  operatingSystem: "Web",
  description:
    "Turn photos and clips into a share-ready video reel for any business — real estate, hospitality, auto, retail, and more. Free, instant, browser-based rendering, no upload required.",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
};

export default function Home() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <main className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-[-8rem] -z-10 flex justify-center blur-3xl"
        >
          <div className="h-[24rem] w-[48rem] rounded-full bg-accent/20" />
        </div>

        <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-10 px-4 py-16 text-center sm:py-24">
          <div className="flex flex-col items-center gap-5">
            <span className="h-14 w-14 text-foreground">
              <ReelIcon />
            </span>
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
              Video Reel Maker for Any Business
            </h1>
            <p className="max-w-xl text-lg text-muted">
              Turn the photos and clips you already have into a finished, share-ready
              video reel — real estate, hotels, auto dealers, shops, or anything else.
              Available on desktop with a live editor, and on mobile with a one-tap quick
              create.
            </p>
          </div>

          <div className="flex flex-wrap justify-center gap-2">
            {EXAMPLE_NICHES.map((niche) => (
              <span
                key={niche}
                className="rounded-full border border-border px-3 py-1 text-sm text-muted"
              >
                {niche}
              </span>
            ))}
            <span className="rounded-full border border-dashed border-border px-3 py-1 text-sm text-muted">
              or anything else
            </span>
          </div>

          <div className="flex gap-3">
            <Link
              href="/signup"
              className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground transition-colors hover:opacity-90"
            >
              Sign up free
            </Link>
            <Link
              href="/login"
              className="rounded-md border border-border px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-surface"
            >
              Sign in
            </Link>
          </div>

          <div className="grid w-full max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-accent/5 p-4 text-left">
              <p className="text-sm font-semibold text-foreground">Edge Render</p>
              <p className="mt-1 text-sm text-muted">
                Free, instant, quick video rendering right in your browser — no upload, no cost, no daily limit.
              </p>
            </div>
            <div className="rounded-lg border border-dashed border-border p-4 text-left">
              <p className="text-sm font-semibold text-foreground">High-quality render</p>
              <p className="mt-1 text-sm text-muted">
                A studio-quality cloud render with full effects support, including auto-captions.
                Coming soon.
              </p>
            </div>
          </div>

          <ol className="flex w-full max-w-md flex-col gap-2 text-left text-sm text-muted">
            <li>
              <strong className="text-foreground">1.</strong> Sign up and tell us your business type
            </li>
            <li>
              <strong className="text-foreground">2.</strong> Upload a few photos or clips
            </li>
            <li>
              <strong className="text-foreground">3.</strong> Render your reel and share the link, or download it
            </li>
          </ol>

          <p className="text-sm text-muted">
            Works great on your phone, too — no desktop required to create a reel on the go.
          </p>
        </div>
      </main>
    </>
  );
}
