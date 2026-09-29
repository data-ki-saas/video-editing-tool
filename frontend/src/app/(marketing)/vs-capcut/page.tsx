import type { Metadata } from "next";
import Link from "next/link";
import { SITE_URL } from "@/lib/siteUrl";

const TITLE = "myreels.in vs CapCut";
const DESCRIPTION =
  "How myreels.in's niche-aware reel maker compares to CapCut for creating business and social media reels.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/vs-capcut" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: `${SITE_URL}/vs-capcut`, siteName: "Reel Creator", type: "website" },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

const ROWS: { feature: string; myreels: string; other: string }[] = [
  {
    feature: "Auto-generated script for your business niche",
    myreels: "Yes — tell it your niche, get a draft script",
    other: "No — you write or paste your own script",
  },
  {
    feature: "Talking on-screen avatar",
    myreels: "Yes, built in",
    other: "Not built in",
  },
  {
    feature: "Business-niche templates (real estate, hotels, auto, retail...)",
    myreels: "Yes",
    other: "General-purpose templates, not niche-specific",
  },
  {
    feature: "Multi-language voiceover, incl. Hindi & other Indian languages",
    myreels: "Yes",
    other: "Limited, mostly manual",
  },
  {
    feature: "Free browser-based rendering, no upload",
    myreels: "Yes (Edge Render)",
    other: "Renders on-device via the app",
  },
  {
    feature: "Editing style",
    myreels: "Guided flow: fill in your niche, get a starting reel",
    other: "Full manual timeline editor — more powerful, steeper to learn",
  },
  {
    feature: "Price",
    myreels: "Free during early access",
    other: "Free, with a paid Pro tier for extra features",
  },
  {
    feature: "Platform",
    myreels: "Works in any browser, desktop or mobile",
    other: "Native mobile and desktop app",
  },
];

export default function VsCapCutPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold text-foreground">myreels.in vs CapCut</h1>
        <p className="text-muted">
          CapCut is a great general-purpose video editor that a lot of creators already know
          and love. myreels.in is built for a narrower job: turning your photos and clips into a
          finished reel for your specific business, fast — with the script, avatar, and
          niche-specific templates handled for you.
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[560px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-surface">
              <th className="p-3 font-medium text-foreground">Feature</th>
              <th className="p-3 font-medium text-foreground">myreels.in</th>
              <th className="p-3 font-medium text-foreground">CapCut</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.feature} className="border-b border-border last:border-b-0">
                <td className="p-3 align-top text-foreground">{row.feature}</td>
                <td className="p-3 align-top text-muted">{row.myreels}</td>
                <td className="p-3 align-top text-muted">{row.other}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted">
        Feature comparisons reflect what each product supports as of writing and can change —
        check CapCut&apos;s own site for their latest details.
      </p>

      <Link
        href="/signup"
        className="self-start rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground transition-colors hover:opacity-90"
      >
        Try myreels.in free
      </Link>
    </main>
  );
}
