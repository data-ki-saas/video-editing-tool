import type { Metadata } from "next";
import { SITE_URL } from "@/lib/siteUrl";

const TITLE = "What's New";
const DESCRIPTION = "A running log of new features and improvements to Reel Creator.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/whats-new" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: `${SITE_URL}/whats-new`, siteName: "Reel Creator", type: "website" },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

interface ChangelogEntry {
  date: string; // ISO, for the <time> element -- formatted for display via formatEntryDate below
  title: string;
  description: string;
  isLatest?: boolean;
}

// Newest first -- add new entries to the TOP of this array as features ship.
const ENTRIES: ChangelogEntry[] = [
  {
    date: "2026-10-09",
    title: "Stretch a video cutaway to loop it",
    description:
      "Drag the right edge of a video cutaway past its end and the footage plays again from the start to fill the extra time, with a thin line marking each restart. Drag it back in to shorten it and the video is simply cut off there. Everything after the cutaway slides along so nothing drifts out of place.",
    isLatest: true,
  },
  {
    date: "2026-10-09",
    title: "Group props and peeps on the time bar",
    description:
      "Right-click a prop or peep on the time bar and choose Group with next to tie it to its neighbour in the same row; repeat to add more. A grouped set gets a white outline and moves as one: drag it along the time bar, Duplicate group, Move group up or down, or Ungroup to edit the pieces again. While grouped, the individual props can't be trimmed or edited.",
  },
  {
    date: "2026-10-08",
    title: "Move overlays up and down the stack",
    description:
      "Right-click a photo, prop or peep on the time bar and choose Move up or Move down to change which one sits in front. The top row is now the front layer, so a character you add later appears on top and you can send it behind another with one click.",
  },
  {
    date: "2026-10-08",
    title: "Peeps: real poses with real hand gestures",
    description:
      "The Peeps popup has a new Real poses tab using the original Open Peeps artwork. Mix a pose (pointing, crossed arms, resting, walking, sitting cross-legged, even a wheelchair or a bike) with any hair, face, beard and glasses, flip it, and add it to your reel. The artwork is black and white, so there's a paint bucket: pick a colour and click the skin, shirt, hair or shoes to fill them. Double-click a figure later to change its pose, face or paint. Or pick a ready-made figure from over 150 busts, standing, sitting and masked characters.",
  },
  {
    date: "2026-10-08",
    title: "Peeps: their own button, save them, edit them again, and copy them",
    description:
      "Peeps now has its own button in the Overlays group, no longer tucked inside Props. Name a peep and save it to My peeps, then load it back any time. Double-click a peep in the preview (or right-click it on the time bar and choose Edit peep) to reopen the peep editor and change its mouth, hair or anything else, handy for making a character talk. Right-click any prop on the time bar and choose Duplicate to copy it, then drag the copy to where you want it.",
  },
  {
    date: "2026-10-07",
    title: "One Images & Videos button for photos and videos",
    description:
      "Video Overlay and Image Overlay are now a single Images & Videos button, just like Cutaway. Pick any video or photo in one place — background removal options appear when you choose a video — and see everything already on your reel, photos and videos together, in one list. A photo overlay now also starts in a box shaped like the photo, so wide pictures aren't cropped.",
  },
  {
    date: "2026-10-07",
    title: "Props: search millions of transparent PNGs",
    description:
      "The Props popup has a new PNG tab. Type anything — a rocket, a coffee cup, a dog — and it searches Wikimedia Commons for openly licensed cut-outs with a see-through background. Click one to drop it into your scene like any other prop: drag, resize, and slide its ends on the time bar. Each result shows its licence, and some ask for a credit if you publish.",
  },
  {
    date: "2026-10-05",
    title: "Props: icons, vectors and build-your-own characters",
    description:
      "The Props popup now has three new tabs. Icons holds Google's Material icons; Vectors searches a huge free library of line and solid vectors, with outline colour, thickness, flip and rotate; and Peeps lets you build a hand-drawn character — pick the hair, face, beard, glasses and mask, choose skin and clothes colours, pick a framing (bust, half body, sitting or full body) and dress the whole figure — gesture (wave, thumbs up, peace, point, hands on hips, crossed arms, cheer), hands, legs (straight, wide, slim, shorts, skirt), shoes and pants colour, or hit Surprise me. Then add it like any other prop: drag, resize, and slide its ends on the time bar. The popup also has a fresh thin blue border.",
  },
  {
    date: "2026-10-04",
    title: "Props: drop a car, a cup or a rocket launcher into your scene",
    description:
      "There's a new Props button in the Overlays group, and behind it a shelf of free, see-through artwork: a car, a motorcycle, a coffee cup, a post box, a signboard, a rocket launcher and more. Click one and it lands at your playhead on its own timeline row. Drag it into place, resize it, and slide its ends to choose how long it stays.",
  },
  {
    date: "2026-10-04",
    title: "Big animated text with no background",
    description:
      "Labels can now be big, bold and see-through: Pop, Slide up, Typewriter, Word by word, Bouncy letters, Slow zoom and Neon glow. Type your words, drag the box over the frame, and watch the animation loop in the preview before you add it.",
  },
  {
    date: "2026-10-04",
    title: "Labels: pills, capsules and price tags",
    description:
      "The Text button is now Label. Pick a pill, capsule or rectangle — including two-tone ones, like a price on blue beside a name on white, or a title stacked over a description — and just type into it. It grows to fit your words. Choose how long it shows on the time bar, and slide it along its own row to move it.",
  },
  {
    date: "2026-10-03",
    title: "Karaoke captions on a single line",
    description:
      "Karaoke captions now show one clean line of words around the one being spoken instead of a wrapped block, and a new Text size slider in the narration dialog lets you make them bigger or smaller.",
  },
  {
    date: "2026-10-03",
    title: "See what you use, and a monthly bill",
    description:
      "Your Usage page now shows the charges so far this month, and a new Monthly billing page lists everything you used — voiceovers, background removal, avatars and AI assistance — with the price each was charged at. Browse previous months any time.",
  },
  {
    date: "2026-10-03",
    title: "Guided tour, help icons and a Starter Reel",
    description:
      "New accounts now open with a ready-made Starter Reel to explore and a short guided tour of the editor. The editor also has little ? icons beside the Reels list, Assets, the toolbar groups, the timeline, the Edits list and the export button — click one for a quick explanation. Replay the tour any time from the ? beside Reels.",
  },
  {
    date: "2026-10-01",
    title: "Meet Aria and Pappu, two new avatars",
    description:
      "Two new ready-made avatars join Maya: Aria, with fuller long hair, expressive eyes with lashes and shaped lips, and Pappu, with short styled hair, a stronger jaw and heavier brows. Both blink, talk and react just like Maya, and now break into a real smile when the mood is happy — pick them from the avatar gallery.",
  },
  {
    date: "2026-09-30",
    title: "Smoother, more expressive avatars",
    description:
      "Avatars now ease between poses instead of snapping, and stay in their talking pose through short pauses between words. New reactions: nod, shake head, thumbs up, a surprised look, a dance, a clap, and a jump — trigger them with tags like {clap} or {jump} in your script. An exclamation mark now perks your avatar up, and a question mark gives a curious head tilt — automatically.",
  },
  {
    date: "2026-09-29",
    title: "See how Myreels.in compares",
    description:
      "New comparison pages on the homepage lay out how Myreels.in stacks up against CapCut and Creatomate — what each is built for, and where Myreels.in's niche-driven scripts, avatar, and free browser rendering fit in.",
  },
  {
    date: "2026-09-29",
    title: "Drag text straight onto your timeline",
    description:
      "Text cutaways can now be dragged directly onto the timeline. Trimming the ends of a cutaway also ripples through your other tracks automatically, so everything stays in sync instead of drifting out of place.",
  },
  {
    date: "2026-09-24",
    title: "More natural avatar movement, and props to hold",
    description:
      "Avatars now bend their elbows and rotate their shoulders like a real person, can hold a mic, pen, or other prop in hand, and laugh with proper mouth and eyebrow motion.",
  },
  {
    date: "2026-09-20",
    title: "Multiple avatars, each with their own line",
    description:
      "Add more than one avatar to a scene and give each their own script — perfect for a back-and-forth or a two-host format. Their voice-over clips are resizable right on the timeline, and we fixed captions incorrectly showing raw mood markup like “{happy}”.",
  },
  {
    date: "2026-09-19",
    title: "Avatars blink, gesture, and react automatically",
    description:
      "Talking avatars now blink on their own, raise their eyebrows to match your script's mood, and can point or react on cue — no manual keyframing needed.",
  },
  {
    date: "2026-09-19",
    title: "A global asset library",
    description:
      "Every avatar, image, and clip you upload is now saved to a shared library you can reuse across all of your projects, not just the one you uploaded it in.",
  },
  {
    date: "2026-09-17",
    title: "Your script's mood drives your avatar",
    description:
      "Add simple tags like {happy} or {serious} to your script and your avatar's expression and gestures follow automatically as it talks.",
  },
  {
    date: "2026-09-15",
    title: "Avatar portrait mode and new outfits",
    description:
      "Frame your avatar in a tighter, bust-up portrait crop, dress it in a new Polo, Suit, or Blazer, and rename any avatar you've generated to keep your library organized.",
  },
  {
    date: "2026-09-14",
    title: "Turn your own photo into an avatar",
    description:
      "Upload a selfie and Reel Creator generates a cartoon-style avatar with your face and hairstyle, ready to talk in your reels.",
  },
  {
    date: "2026-09-13",
    title: "Meet your on-screen avatar",
    description:
      "A brand-new, in-house animated avatar system: pick a character, have it speak your script with synced lip movement and timed actions, and tweak its look just by typing what you want changed — “make it taller,” “add sunglasses,” “look more serious.”",
  },
  {
    date: "2026-09-10",
    title: "A dedicated overlay editor, plus cutaway filters and background removal",
    description:
      "Click any overlay right on the timeline to edit it directly, and give your cutaway clips a color filter or one-tap background removal from the same editor.",
  },
  {
    date: "2026-09-09",
    title: "Text slides",
    description:
      "Add a full-screen text slide as its own clip type, right alongside your video and photo cutaways.",
  },
  {
    date: "2026-09-09",
    title: "Get help without leaving the app",
    description:
      "Open a support ticket right from Reel Creator if you run into an issue — no need to dig up an email address.",
  },
  {
    date: "2026-09-08",
    title: "Recording on mobile, reworked",
    description:
      "Recording straight from your phone now fills the whole screen, ties your script directly to the recording so the teleprompter matches it, and remembers your teleprompter speed between sessions.",
  },
  {
    date: "2026-09-07",
    title: "Background music, as movable clips",
    description:
      "Instead of one looping track, add multiple background-music clips and drag or resize them anywhere on the timeline, just like your video clips.",
  },
  {
    date: "2026-09-07",
    title: "Teleprompter for in-app recording",
    description:
      "Recording yourself straight from the app now has a built-in teleprompter — paste your script and it scrolls on its own, right near the camera lens, so you can read while still looking at the camera. Recording on your phone also now defaults to the front camera, with a digital zoom slider to frame your shot.",
  },
  {
    date: "2026-09-06",
    title: "Face effects: a glowing torus or halo",
    description:
      "A glowing ring can now lock onto a photo's detected head — spinning just above it like a torus, or glowing softly behind it like a halo. Pick one from the same cutaway options as “Make it 3D” and Ambience, and combine it freely with either.",
  },
  {
    date: "2026-09-05",
    title: "Post straight to YouTube",
    description:
      "Connect your YouTube account once in Settings, then post any saved reel with a single click — right from your Library or straight after a render.",
  },
  {
    date: "2026-09-05",
    title: "“Make it 3D” now has real depth",
    description:
      "Your photo's subject now lifts off the background as the camera moves, instead of the whole photo just moving as one flat layer — genuine depth, not a bigger zoom. Automatic the moment you turn on “Make it 3D,” no extra steps.",
  },
  {
    date: "2026-09-05",
    title: "Your personal Library",
    description:
      "Every reel you render can now be saved to your own Library. Rename it, jot a quick description, delete what you don't need, and mark your favorites as reusable Templates — with instant, sound-off previews right in the grid.",
  },
  {
    date: "2026-09-04",
    title: "Pulse with music",
    description:
      "Turn on “Pulse with music” and your visuals gently scale in time with your background track, automatically — no beat-matching or manual keyframing required.",
  },
  {
    date: "2026-09-04",
    title: "Sign in with Google",
    description: "One tap and you're in — no password to create or remember.",
  },
  {
    date: "2026-09-03",
    title: "Create reels in Hindi and five more Indian languages",
    description:
      "Generate scripts, on-screen text, and natural-sounding voiceovers in Hindi and other Indian languages, with live phonetic transliteration as you type.",
  },
  {
    date: "2026-09-03",
    title: "More ambient effects: rain, mist, sun rays, and crackers",
    description:
      "Joining light sweep, sparkle, and drifting leaves — layer a soft rain shower, a misty cloud, warm sun rays, or celebratory sparks right onto your footage.",
  },
  {
    date: "2026-09-02",
    title: "“Make it 3D” launches",
    description:
      "A real camera move for your photo cutaways — push in, pan, and tilt like an actual camera, not just a flat zoom.",
  },
];

function formatEntryDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function WhatsNewPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold text-foreground">What&apos;s New</h1>
        <p className="text-muted">
          New features and improvements to Reel Creator, newest first.
        </p>
      </div>

      <ol className="flex flex-col gap-8">
        {ENTRIES.map((entry) => (
          <li key={`${entry.date}-${entry.title}`} className="flex flex-col gap-1.5 border-l-2 border-border pl-4">
            <div className="flex flex-wrap items-center gap-2">
              <time dateTime={entry.date} className="text-sm text-muted">
                {formatEntryDate(entry.date)}
              </time>
              {entry.isLatest && (
                <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
                  Latest
                </span>
              )}
            </div>
            <h2 className="text-lg font-medium text-foreground">{entry.title}</h2>
            <p className="text-muted">{entry.description}</p>
          </li>
        ))}
      </ol>
    </main>
  );
}
