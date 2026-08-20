import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Use",
  description: "Terms for using Reel Creator.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-16">
      <h1 className="text-3xl font-semibold">Terms of Use</h1>

      {/* Placeholder -- this is not real, legally-reviewed terms of use.
          Replace before relying on this for real users. */}
      <p className="text-sm text-neutral-500">Last updated: placeholder — not yet legally reviewed.</p>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Your content</h2>
        <p className="text-neutral-600">
          You own the photos, clips, and reels you create. You&apos;re responsible for
          having the rights to anything you upload.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Fair use</h2>
        <p className="text-neutral-600">
          Daily limits on uploads and renders exist to keep the service usable for
          everyone during early access — see{" "}
          <a href="/docs" className="underline">
            Documentation
          </a>
          .
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Early access</h2>
        <p className="text-neutral-600">
          Reel Creator is under active development. Features may change, and we
          can&apos;t guarantee uninterrupted availability during this stage.
        </p>
      </section>
    </main>
  );
}
