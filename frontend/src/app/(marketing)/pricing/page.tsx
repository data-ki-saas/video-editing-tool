import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Reel Creator is free during early access. Paid plans are coming later.",
  alternates: { canonical: "/pricing" },
};

export default function PricingPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-16">
      <h1 className="text-3xl font-semibold">Pricing</h1>

      <section className="flex flex-col gap-3 rounded-md border border-neutral-300 p-6">
        <h2 className="text-lg font-medium">Early access — free</h2>
        <p className="text-neutral-600">
          {/* Placeholder -- this app has no billing yet by design (see the
              project's own README). Replace this section once real plans exist. */}
          Reel Creator is currently free to use while we&apos;re in early access.
          Create an account, pick your business niche, and start making reels — no
          credit card required.
        </p>
        <Link
          href="/signup"
          className="mt-2 self-start rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Sign up free
        </Link>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">What&apos;s next</h2>
        <p className="text-neutral-600">
          We plan to introduce paid plans as the product matures — likely priced around
          how many reels you create per month, with a generous free tier for trying it
          out. Nothing is finalized yet, and existing early-access users will hear about
          any pricing changes well in advance.
        </p>
      </section>
    </main>
  );
}
