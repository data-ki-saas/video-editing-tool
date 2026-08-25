"use client";

/**
 * The main sequence's own audio, shown as one solid rail spanning the full
 * video duration -- same flat, synced-scroll strip shape as
 * BackgroundTrackStrip, but far simpler: the main sequence's audio is
 * neither multi-track nor looped, so there's no per-track duration probing
 * or concatenation to do, just the one span. Deliberately a strong, solid
 * color distinct from BackgroundTrackStrip's muted accent-colored segments
 * -- this IS the reel's primary audio, not a secondary layer under it, and
 * should read that way at a glance. A MicrophoneIcon badge at the rail's
 * own left edge (scrolls with the content, so it stays at time 0 -- same
 * convention as TrimTrack's ScissorsIcon) tells it apart from
 * BackgroundTrackStrip's own MusicNoteIcon badge at a glance, in case the
 * color alone isn't enough.
 *
 * `hide-scrollbar` (unlike BackgroundTrackStrip, the bottom-most of the
 * three synced strips) -- see globals.css's own comment: only the
 * bottom-most strip's native scrollbar is left visible, as the one
 * scrollbar for the whole Playground stack.
 */
import { MicrophoneIcon } from "@/components/icons/UIIcons";

export function MainAudioTrackStrip({
  videoDurationSeconds,
  pixelsPerSecond,
  scrollContainerRef,
  onScroll,
}: {
  videoDurationSeconds: number;
  pixelsPerSecond: number;
  scrollContainerRef: (el: HTMLDivElement | null) => void;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
}) {
  if (videoDurationSeconds <= 0) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 px-2 text-xs text-muted">
        No audio yet
      </div>
    );
  }

  return (
    <div
      ref={scrollContainerRef}
      onScroll={onScroll}
      className="hide-scrollbar h-full overflow-x-auto bg-neutral-950 px-2"
    >
      <div
        title="This reel's own captured sound"
        className="relative h-full rounded-sm bg-amber-500"
        style={{ width: videoDurationSeconds * pixelsPerSecond }}
      >
        <MicrophoneIcon className="pointer-events-none absolute left-0.5 top-1/2 z-10 h-2.5 w-2.5 -translate-y-1/2 text-white drop-shadow-[0_0_1px_rgba(0,0,0,0.9)]" />
      </div>
    </div>
  );
}
