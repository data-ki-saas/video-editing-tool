import type { Metadata } from "next";
import { SITE_URL } from "@/lib/siteUrl";

const TITLE = "Documentation";
const DESCRIPTION =
  "How Reel Creator works, in plain English: start a reel, drop in your footage, add props, labels, zooms and effects, then render it free in your browser.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/docs" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: `${SITE_URL}/docs`, siteName: "Reel Creator", type: "website" },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
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
      <p className="text-muted">{children}</p>
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
//
// Placed inline right under the Topic it demonstrates rather than pooled
// into one shared "Examples" section at the top of the page -- new feature
// examples get added here over time, and grouping them all in one spot
// would just keep growing a pile disconnected from the feature it's
// showing off.
function VideoExample({ title, shareUrl, children }: { title: string; shareUrl: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <div className="aspect-[9/16] w-full max-w-[220px] shrink-0 overflow-hidden rounded-md border border-border bg-black">
        <iframe
          src={shareUrl}
          title={title}
          allow="autoplay; fullscreen"
          className="h-full w-full border-0"
        />
      </div>
      <div className="flex flex-col gap-2 sm:pt-1">
        <h3 className="text-lg font-medium">{title}</h3>
        <p className="text-muted">{children}</p>
      </div>
    </div>
  );
}

// Voice for everything below: talk to the creator like a friend who edits for
// a living -- "you", concrete scenes ("a coffee cup on the table"), short
// sentences, a little humor, and no editing jargon without saying what it
// does. Say what they'll see happen, not how it works under the hood. When a
// feature ships, add its Topic here in that same voice (and a What's New
// entry); don't let this drift back into spec-sheet language.
export default function DocsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-14 px-4 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">Documentation</h1>
        <p className="text-muted">
          You&apos;ve got raw footage on your phone and a reel in your head. This is how you get from
          one to the other &mdash; no editing degree required.
        </p>
      </div>

      <Category title="Getting your reel started">
        <Topic title="Getting started">
          From your dashboard, hit <strong>New Reel</strong> and tell us what it&apos;s for &mdash; a
          property listing, a hotel, a car showroom, a saree shop, a gift store, a hardware
          counter, or something we haven&apos;t thought of yet. Answer a few quick questions and
          you&apos;re dropped straight into the editor with a head start, not a blank screen.
        </Topic>
        <Topic title="Adding assets">
          Bring your own photos, videos and music, or hunt through free stock photos and music
          without leaving the editor. Then right-click (or long-press) anything to put it to work:
          a video clip joins your sequence and plays after whatever&apos;s already there, a photo
          lands on top of your video as an overlay, and a music track becomes your soundtrack. Add
          several clips and they play back to back. Add several songs and they take turns,
          looping for as long as your video runs.
        </Topic>
        <Topic title="Teleprompter">
          Filming yourself in the app? Tap the script icon, paste in what you want to say, and the
          words scroll by on their own &mdash; right beside the camera lens, so you can read and still
          look like you&apos;re talking straight to your audience. It finds a comfortable pace for
          you, and tucking it away between takes doesn&apos;t lose your place.
        </Topic>
      </Category>

      <Category title="Shaping the video">
        <Topic title="Clip (aspect ratio)">
          Decide what shape your reel is &mdash; tall for Reels and Shorts, widescreen, square,
          cinematic &mdash; then drag the frame around to choose exactly what stays in view.
        </Topic>
        <Topic title="Zoom & pan">
          Want to push in on the good part? Drag the frame at that moment in your video and a smooth
          zoom or pan is set up for you. It eases in, then eases back out by itself, so there are no
          keyframes to babysit.
        </Topic>
        <Topic title="Flip & mirror">
          Flip your footage sideways or upside down from any point on the timeline, and flip it back
          later if you only needed it for a moment.
        </Topic>
        <Topic title="Trim">
          Got a stretch you&apos;d rather nobody saw &mdash; the fumbled intro, the long pause? Cut it
          out. It&apos;s gone from playback, not just hidden.
        </Topic>
        <Topic title="Undo & redo">
          Every change can be undone and redone, so go ahead and try the wild idea. You can always
          step back.
        </Topic>
      </Category>

      <Category title="Layering things on top">
        <Topic title="Overlays">
          Put a photo on top of your video for exactly as long as you want it there, then drag it to
          wherever it looks best on the frame. Each overlay gets its own row on the timeline, so
          you can see at a glance what&apos;s showing when.
        </Topic>
        <Topic title="Props">
          Some things are easier to add than to film. Open <strong>Props</strong> and you&apos;ll find a
          shelf of ready-made, see-through artwork &mdash; a car, a motorcycle, a coffee cup, a post
          box, a signboard, even a rocket launcher &mdash; free to use. Click one and it appears at
          your playhead on its own timeline row, with nothing but the object itself (no box around
          it). Drag it into the scene, stretch it to size, and slide its ends to choose how long it
          sticks around. Because a prop is a regular overlay under the hood, everything else works
          on it too: filters, Make it 3D, ambient effects.
        </Topic>
        <Topic title="Labels">
          Need a price tag, a name badge or a shop title? Hit <strong>Label</strong> and pick a pill,
          a capsule or a rectangle &mdash; including two-tone ones, like a price on blue beside a name
          on white, or a headline stacked over a smaller description. Type straight into it and the
          label grows or shrinks to fit your words. Prefer something louder? The big, see-through
          animated styles &mdash; Pop, Slide up, Typewriter, Word by word, Bouncy letters, Slow zoom and
          Neon glow &mdash; loop in the preview so you can watch them perform before you commit. Choose
          how long a label shows on the time bar, and slide it along its own row to move it. Come
          back any time to change the wording, style or position.
        </Topic>
      </Category>

      <Category title="Making it look expensive">
        <Topic title="Make it 3D">
          Flip on Make it 3D for a photo cutaway and the picture stops being a picture. The subject
          lifts away from its background while the camera pushes in, pans and tilts &mdash; real depth,
          not a flat zoom. Your still photo suddenly feels like a shot.
        </Topic>
        <VideoExample
          title="3D Ken Burns, pulsing with the beat"
          shareUrl={`${SITE_URL}/share/2cd5793b-5db8-4902-a2af-6075f1ef98f3`}
        >
          Same photo, now a proper camera move: the subject floats off its background as the camera
          glides in. Here it&apos;s paired with Pulse with music, so the whole thing breathes with
          the beat.
        </VideoExample>
        <Topic title="Ambient effects">
          Give a photo or overlay some atmosphere: a light sweep, sparkle, drifting leaves, rain,
          mist, sun rays or crackers. Pick one from the Ambience option when you add it, and the
          mood changes without touching anything else.
        </Topic>
        <VideoExample
          title="Ken Burns with animated sparkle"
          shareUrl={`${SITE_URL}/share/e9fb44f2-2593-4b19-97fb-6c7ec7af5dea`}
        >
          A photo with a slow Ken Burns drift and a soft Sparkle floating across it. It&apos;s one of
          a whole set of ambient effects (light sweep, leaves, rain, mist, sun rays, crackers) you
          can add to any photo or overlay.
        </VideoExample>
        <Topic title="Face effects">
          If your photo has a face in it, we&apos;ll find it and let you crown it &mdash; a Torus
          spinning just above the head, or a soft Halo glowing behind it. Choose one from the Face
          effect option when you add the photo, and mix it freely with Make it 3D or Ambience.
        </Topic>
        <Topic title="Pulse with music">
          Switch on Pulse with music and a photo or overlay gently swells and settles in time with
          your soundtrack. It&apos;s the easiest way to make a reel feel alive, and there&apos;s
          nothing to line up by hand.
        </Topic>
        <VideoExample
          title="Ken Burns that pulses with the beat"
          shareUrl={`${SITE_URL}/share/05bac439-f4eb-4cb1-a668-59116add98ab`}
        >
          A Ken Burns cutaway with Pulse with music on. Watch it grow and shrink along with the
          track &mdash; all automatic, no keyframes anywhere.
        </VideoExample>
        <Topic title="Filters">
          Right-click (or long-press) any cutaway or overlay and choose Filter to give it its own
          look: Original, Black &amp; White, Vivid, Vintage, Warm, Cool or High Contrast. Every clip
          keeps its own filter, so a vintage photo can sit next to a vivid one without a fight.
        </Topic>
      </Category>

      <Category title="Creating the final reel">
        <Topic title="Edge Render (free)">
          Press Edge Render and your reel is built right inside your browser. Nothing is uploaded to
          a rendering service, it costs nothing, and there&apos;s no daily limit &mdash; it plays and
          downloads the moment it&apos;s ready. You&apos;ll need Chrome or Microsoft Edge, and
          auto-captions aren&apos;t supported in this mode yet.
        </Topic>
        <Topic title="High-quality render (coming soon)">
          A second, higher-quality render is on its way. It runs on our servers instead of your
          device and will support every feature, auto-captions included.
        </Topic>
        <Topic title="Limits">
          {/* Placeholder -- keep in sync with README.md's "Abuse guardrails" if the cap changes. */}
          While we&apos;re in early access, there&apos;s a daily cap on how many high-quality cloud
          renders an account can start, so things stay snappy for everyone. If you hit it,
          you&apos;ll get a clear message saying when to come back. Edge Render doesn&apos;t have a
          cap at all.
        </Topic>
      </Category>

      <Category title="Sharing">
        <Topic title="Post to YouTube">
          Connect your YouTube account once in Settings, and from then on a saved reel is one click
          from being live &mdash; from your Library, or straight after a render. Your reel&apos;s name
          becomes the video title, so there&apos;s no extra form to fill in.
        </Topic>
      </Category>
    </main>
  );
}
