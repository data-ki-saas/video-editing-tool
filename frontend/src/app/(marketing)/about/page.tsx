import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About Us",
  description:
    "Timeline Editor helps real estate agents, hotels, auto dealers, and small businesses of any niche turn photos and clips into a finished promotional video reel in minutes.",
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-16">
      <h1 className="text-3xl font-semibold">About Timeline Editor</h1>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">What we do</h2>
        <p className="text-neutral-600">
          {/* Placeholder copy -- replace with your real founding story once one exists. */}
          Timeline Editor turns the photos and video clips you already have into a
          finished, share-ready reel — no video editing experience required. Pick your
          business type, upload a few photos, and get a rendered vertical video with
          captions and music in minutes.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Who it&apos;s for</h2>
        <p className="text-neutral-600">
          Real estate agents, hotels and short-term rentals, auto dealers, garment and
          gift shops, hardware stores — or any business type at all. The form you fill
          out to create a reel adapts automatically to whatever niche you tell it about.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Where we are today</h2>
        <p className="text-neutral-600">
          Timeline Editor is in early access. We&apos;re actively building — see{" "}
          <a href="/docs" className="underline">
            Documentation
          </a>{" "}
          for what&apos;s available right now.
        </p>
      </section>
    </main>
  );
}
