import type { Metadata } from "next";
import Link from "next/link";
import { SITE_URL } from "@/lib/siteUrl";

const TITLE = "myreels.in vs Creatomate";
const DESCRIPTION =
  "How myreels.in's end-to-end reel creator compares to Creatomate's developer-focused video rendering API.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/vs-creatomate" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: `${SITE_URL}/vs-creatomate`,
    siteName: "Reel Creator",
    type: "website",
  },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

const ROWS: { feature: string; myreels: string; other: string }[] = [
  {
    feature: "Who it's for",
    myreels: "Individual creators and small businesses making their own reels",
    other: "Developers and teams automating video generation in their own product",
  },
  {
    feature: "Ready-to-use creator UI (no coding)",
    myreels: "Yes — sign up and start creating",
    other: "No — used via API or templates, typically wired up by a developer",
  },
  {
    feature: "Auto-generated script for your business niche",
    myreels: "Yes",
    other: "No — you supply the content and template",
  },
  {
    feature: "Talking on-screen avatar",
    myreels: "Yes, built in",
    other: "Not built in",
  },
  {
    feature: "Rendering",
    myreels: "Free, instant, in your browser (Edge Render)",
    other: "Cloud rendering, billed by usage",
  },
  {
    feature: "Price",
    myreels: "Free during early access",
    other: "Paid, usage-based API pricing",
  },
];

export default function VsCreatomatePage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold text-foreground">myreels.in vs Creatomate</h1>
        <p className="text-muted">
          Creatomate is a solid video rendering API that developers use to automate video
          generation inside their own apps. myreels.in is a finished, self-serve product — you
          don&apos;t need to build anything. Sign up, tell it about your business, and get a
          rendered reel out the other end.
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[560px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-surface">
              <th className="p-3 font-medium text-foreground">Feature</th>
              <th className="p-3 font-medium text-foreground">myreels.in</th>
              <th className="p-3 font-medium text-foreground">Creatomate</th>
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
        check Creatomate&apos;s own site for their latest details.
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
