import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "What's New",
  description: "A running log of new features and improvements to Reel Creator.",
  alternates: { canonical: "/whats-new" },
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
    date: "2026-09-05",
    title: "“Make it 3D” now has real depth",
    description:
      "Your photo's subject now lifts off the background as the camera moves, instead of the whole photo just moving as one flat layer — genuine depth, not a bigger zoom. Automatic the moment you turn on “Make it 3D,” no extra steps.",
    isLatest: true,
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
