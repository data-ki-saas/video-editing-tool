import type { Metadata } from "next";
import Link from "next/link";
import { ReelIcon } from "@/components/IconButton";

const SITE_URL = "https://video-editing-tool-gamma.vercel.app";

// Title/description tuned for people searching for what this actually is:
// a video reel maker that works across business types, not a single-niche
// tool -- "for any business" and the explicit niche list both matter for
// matching real search intent (e.g. "auto dealership video maker",
// "real estate listing video generator").
export const metadata: Metadata = {
  title: "Video Reel Maker for Any Business",
  description:
    "Turn your photos and clips into a share-ready video reel — for real estate, hotels, auto dealers, garment and gift shops, hardware stores, or any business. Works on desktop and mobile. Free to start.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "Timeline Editor — Video Reel Maker for Any Business",
    description:
      "Turn your photos and clips into a share-ready video reel, for any business niche. Works on desktop and mobile.",
    url: SITE_URL,
    siteName: "Timeline Editor",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Timeline Editor — Video Reel Maker for Any Business",
    description: "Turn your photos and clips into a share-ready video reel, for any business niche.",
  },
};

const EXAMPLE_NICHES = [
  "Real estate",
  "Hotels & short-term rentals",
  "Auto dealerships",
  "Garment shops",
  "Gift shops",
  "Hardware stores",
];

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Timeline Editor",
  applicationCategory: "MultimediaApplication",
  operatingSystem: "Web",
  description:
    "Turn photos and clips into a share-ready video reel for any business — real estate, hospitality, auto, retail, and more.",
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

      <main className="mx-auto flex w-full max-w-3xl flex-col items-center gap-10 px-4 py-16 text-center">
        <div className="flex flex-col items-center gap-4">
          <span className="h-14 w-14 text-neutral-900">
            <ReelIcon />
          </span>
          <h1 className="text-3xl font-semibold sm:text-4xl">Video Reel Maker for Any Business</h1>
          <p className="max-w-xl text-neutral-600">
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
              className="rounded-full border border-neutral-300 px-3 py-1 text-sm text-neutral-600"
            >
              {niche}
            </span>
          ))}
          <span className="rounded-full border border-dashed border-neutral-300 px-3 py-1 text-sm text-neutral-500">
            or anything else
          </span>
        </div>

        <ol className="flex w-full max-w-md flex-col gap-2 text-left text-sm text-neutral-600">
          <li>
            <strong>1.</strong> Sign up and tell us your business type
          </li>
          <li>
            <strong>2.</strong> Upload a few photos or clips
          </li>
          <li>
            <strong>3.</strong> Render your reel and share the link, or download it
          </li>
        </ol>

        <p className="text-sm text-neutral-500">
          Works great on your phone, too — no desktop required to create a reel on the go.
        </p>

        <div className="flex gap-3">
          <Link
            href="/signup"
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
          >
            Sign up free
          </Link>
          <Link
            href="/login"
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100"
          >
            Sign in
          </Link>
        </div>
      </main>
    </>
  );
}
