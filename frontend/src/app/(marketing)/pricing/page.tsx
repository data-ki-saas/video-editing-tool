import type { Metadata } from "next";
import Link from "next/link";
import { SITE_URL } from "@/lib/siteUrl";

const TITLE = "Pricing";
const DESCRIPTION = "Reel Creator is free during early access. Paid plans are coming later.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/pricing" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: `${SITE_URL}/pricing`, siteName: "Reel Creator", type: "website" },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

export default function PricingPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-16">
      <h1 className="text-3xl font-semibold">Pricing</h1>

      <section className="flex flex-col gap-3 rounded-md border border-border p-6">
        <h2 className="text-lg font-medium">Early access — free</h2>
        <p className="text-muted">
          {/* Placeholder -- this app has no billing yet by design (see the
              project's own README). Replace this section once real plans exist. */}
          Reel Creator is currently free to use while we&apos;re in early access.
          Create an account, pick your business niche, and start making reels — no
          credit card required.
        </p>
        <Link
          href="/signup"
          className="mt-2 self-start rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:opacity-90"
        >
          Sign up free
        </Link>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">What&apos;s next</h2>
        <p className="text-muted">
          We plan to introduce paid plans as the product matures — likely priced around
          how many reels you create per month, with a generous free tier for trying it
          out. Nothing is finalized yet, and existing early-access users will hear about
          any pricing changes well in advance.
        </p>
      </section>
    </main>
  );
}
