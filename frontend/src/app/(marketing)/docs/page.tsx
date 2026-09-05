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

// A shared reel (see app/library/page.tsx's Share action / app/share/
// [videoId]/page.tsx) embedded next to its own caption -- laid out in a
// row rather than stacked, since the reel itself is a tall 9:16 clip and
// reads much better beside its description than above/below it, same
// "image beside its caption" shape print/blog articles use for a portrait
// photo. Stacks back to a column below `sm` (a 9:16 video and a paragraph
// side by side get too cramped on a narrow phone screen).
function VideoExample({ title, shareUrl, children }: { title: string; shareUrl: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <div className="aspect-[9/16] w-full max-w-[220px] shrink-0 overflow-hidden rounded-md border border-neutral-300 bg-black">
        <iframe
          src={shareUrl}
          title={title}
          allow="autoplay; fullscreen"
          className="h-full w-full border-0"
        />
      </div>
      <div className="flex flex-col gap-2 sm:pt-1">
        <h3 className="text-lg font-medium">{title}</h3>
        <p className="text-neutral-600">{children}</p>
      </div>
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

      <Category title="Examples">
        <VideoExample
          title="Ken Burns with animated sparkle"
          shareUrl="https://video-editing-tool-gamma.vercel.app/share/e9fb44f2-2593-4b19-97fb-6c7ec7af5dea"
        >
          A photo cutaway animated with a Ken Burns zoom/pan, with the Sparkle ambient effect
          layered softly on top — one of a full library of effects (light sweep, sparkle, leaves,
          rain, mist, sun rays, crackers) you can add to any photo or overlay.
        </VideoExample>
        <VideoExample
          title="Ken Burns that pulses with the beat"
          shareUrl="https://video-editing-tool-gamma.vercel.app/share/05bac439-f4eb-4cb1-a668-59116add98ab"
        >
          The same kind of Ken Burns cutaway, this time with Pulse with music turned on — it
          gently grows and shrinks in time with the background track automatically, no
          keyframing required.
        </VideoExample>
        <VideoExample
          title="3D Ken Burns, pulsing with the beat"
          shareUrl="https://video-editing-tool-gamma.vercel.app/share/20c39cf7-f4ab-4baf-8cc3-fc67834ef8a8"
        >
          Make it 3D turns the same cutaway into a real camera move — the photo&apos;s own subject
          lifts off its background as the camera pushes in and pans, genuine depth rather than a
          flat zoom — combined here with Pulse with music for both effects at once.
        </VideoExample>
      </Category>

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
        <Topic title="Pulse with music">
          Turn on Pulse with music on any photo cutaway or overlay and it subtly grows and shrinks
          in time with your background track — an automatic way to make your reel feel more alive
          and in sync with the beat, with nothing to keyframe by hand.
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
