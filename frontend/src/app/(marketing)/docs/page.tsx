import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "How Reel Creator works: getting started, adding assets, editing actions, and generating your reel — including free, instant, browser-based rendering.",
  alternates: { canonical: "/docs" },
};

function Category({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-6">
      <h2 className="text-2xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Topic({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-lg font-medium">{title}</h3>
      <p className="text-neutral-600">{children}</p>
    </div>
  );
}

export default function DocsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-14 px-4 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">Documentation</h1>
        <p className="text-neutral-600">
          Everything you need to go from a blank project to a finished, share-ready reel.
        </p>
      </div>

      <Category title="Editing">
        <Topic title="Getting started">
          From your dashboard, click <strong>New Reel</strong> and tell us what kind of business
          it&apos;s for — real estate, a hotel, an auto dealership, a garment or gift shop, a
          hardware store, or anything else. Fill in a few details and you&apos;ll land straight in
          the editor.
        </Topic>
        <Topic title="Adding assets">
          Upload your own photos, videos, and music, or search free stock photos and music
          without ever leaving the editor. Right-click (or long-press) any asset to add it to
          your reel: a video clip joins your sequence and plays after whatever&apos;s already
          there, a photo becomes an overlay on top of your video, and a music track becomes your
          background music. Add more than one video clip and they play back-to-back; add more
          than one music track and they play one after another, looping for as long as your video
          runs.
        </Topic>
      </Category>

      <Category title="Actions">
        <Topic title="Clip (aspect ratio)">
          Pick the shape of your finished video — widescreen, portrait, square, cinematic, and
          more — then drag the frame to choose exactly what stays visible.
        </Topic>
        <Topic title="Zoom & pan">
          Drag the frame at any point in your video to set up a smooth zoom or pan there. It eases
          in and back out on its own — no keyframes to manage by hand.
        </Topic>
        <Topic title="Flip & mirror">
          Flip your footage horizontally or vertically starting from any point in the video, and
          flip it back later if you only want it for a stretch.
        </Topic>
        <Topic title="Trim">
          Cut out any stretch of video you don&apos;t want. It&apos;s removed from playback
          entirely, not just hidden.
        </Topic>
        <Topic title="Overlays">
          Place a photo on top of your video for however long you want it visible, and drag it
          wherever it should sit on the frame.
        </Topic>
        <Topic title="Text captions">
          Type a caption, pick a style, and drag it into place. It appears for whatever stretch of
          the video you choose, and you can come back and edit the wording, style, or position
          any time.
        </Topic>
        <Topic title="Undo & redo">
          Every change you make while editing can be undone or redone, so it&apos;s always safe to
          experiment.
        </Topic>
      </Category>

      <Category title="Generation">
        <Topic title="Edge Render (free)">
          Hit the Edge Render button to generate your reel right in your browser — no upload to a
          rendering service, no cost, and no daily limit. It plays and downloads as soon as
          it&apos;s done. Edge Render needs a Chromium browser (Chrome or Microsoft Edge) and
          doesn&apos;t yet support auto-captions.
        </Topic>
        <Topic title="High-quality render (coming soon)">
          A second, higher-quality cloud render is on the way — full support for every editing
          feature including auto-captions, rendered on our servers rather than your device.
        </Topic>
        <Topic title="Limits">
          {/* Placeholder -- keep in sync with README.md's "Abuse guardrails" if the cap changes. */}
          To keep things running smoothly for everyone during early access, there&apos;s a daily
          limit on how many high-quality cloud renders an account can start. If you hit it,
          you&apos;ll see a clear message telling you when to try again — Edge Render has no such
          limit.
        </Topic>
      </Category>
    </main>
  );
}
