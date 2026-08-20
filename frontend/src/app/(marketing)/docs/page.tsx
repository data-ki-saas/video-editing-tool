import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Documentation",
  description: "How Reel Creator works: create a reel, upload photos or clips, and render a finished video.",
  alternates: { canonical: "/docs" },
};

export default function DocsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-16">
      <h1 className="text-3xl font-semibold">Documentation</h1>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">1. Create a reel</h2>
        <p className="text-neutral-600">
          From your dashboard, click <strong>New Reel</strong> and tell us what kind of
          business it&apos;s for — real estate, a hotel, an auto dealership, a garment
          or gift shop, a hardware store, or anything else. The form that follows adapts
          automatically to your niche.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">2. Add your photos or clips</h2>
        <p className="text-neutral-600">
          Upload the photos and video clips you want in the reel. On desktop, arrange
          them on a timeline with a live preview as you edit. On mobile, add your
          photos and we&apos;ll assemble a reel for you automatically — no editing
          required.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">3. Render and share</h2>
        <p className="text-neutral-600">
          Hit render, and your finished vertical video is ready shortly after — with a
          link you can share or download directly.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Works on your phone too</h2>
        <p className="text-neutral-600">
          {/* Mobile quick-create -- see frontend/src/components/QuickCreate.tsx */}
          Creating a reel doesn&apos;t require a desktop. On a phone, Reel Creator
          switches to a simplified flow: add your photos, tap create, and get your
          reel — perfect for adding a listing or a new arrival on the go.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Limits</h2>
        <p className="text-neutral-600">
          {/* Placeholder -- keep in sync with README.md's "Abuse guardrails" if the cap changes. */}
          To keep things running smoothly for everyone during early access, there&apos;s
          a daily limit on how many renders an account can start. If you hit it,
          you&apos;ll see a clear message telling you when to try again.
        </p>
      </section>
    </main>
  );
}
