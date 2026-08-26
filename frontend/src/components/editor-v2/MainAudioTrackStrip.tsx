"use client";

/**
 * The main sequence's own audio, shown as one solid rail spanning the full
 * video duration -- same flat, synced-scroll strip shape as
 * BackgroundTrackStrip, but far simpler: the main sequence's audio is
 * neither multi-track nor looped, so there's no per-track duration probing
 * or concatenation to do, just the one span. Deliberately a strong, solid
 * color distinct from BackgroundTrackStrip's muted accent-colored segments
 * -- this IS the reel's primary audio, not a secondary layer under it, and
 * should read that way at a glance. Sits directly below FrameStrip in
 * Playground.tsx -- immediately under the video frames it's the audio for.
 * (This rail doesn't render its own MicrophoneIcon badge -- Playground.tsx
 * overlays one, followed by the VolumeBadge, on this rail's left edge; see
 * that file's own module comment.)
 *
 * A one-second ruler (a horizontal line the full width of the rail, with a
 * tick crossing it every second at the same `pixelsPerSecond` scale the
 * other synced strips use) gives this rail a sense of elapsed time on its
 * own, without needing to line it up against FrameStrip's tiles to tell.
 *
 * `hide-scrollbar`, same as FrameStrip/BackgroundTrackStrip -- see
 * globals.css's own comment. Playground.tsx's own proxy scrollbar row, at
 * the very bottom of the whole synced group (below both audio rails), is
 * the one visible, draggable affordance; this rail still stays scrollable
 * via trackpad/wheel too.
 *
 * Click-to-seek works here exactly like FrameStrip's own click handler --
 * this rail is part of the same shared timeline, so scrubbing shouldn't
 * only work from the video frames above it. The red playhead itself still
 * lives solely in FrameStrip (currentTimeSeconds is shared editor state),
 * so a click here just moves that same line rather than drawing a second
 * one of its own.
 */
import { useRef } from "react";

export function MainAudioTrackStrip({
  videoDurationSeconds,
  pixelsPerSecond,
  onSeek,
  scrollContainerRef,
  onScroll,
}: {
  videoDurationSeconds: number;
  pixelsPerSecond: number;
  onSeek: (seconds: number) => void;
  scrollContainerRef: (el: HTMLDivElement | null) => void;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  if (videoDurationSeconds <= 0) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 px-2 text-xs text-muted">
        No audio yet
      </div>
    );
  }

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (videoDurationSeconds <= 0 || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const fraction = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    onSeek(fraction * videoDurationSeconds);
  }

  // One tick per whole second, including a trailing tick for a
  // non-whole-second duration's final partial second.
  const secondTicks = Array.from({ length: Math.floor(videoDurationSeconds) + 1 }, (_, second) => second);

  return (
    <div
      ref={scrollContainerRef}
      onScroll={onScroll}
      className="hide-scrollbar h-full overflow-x-auto bg-neutral-950 px-2"
    >
      <div
        ref={trackRef}
        onClick={handleClick}
        title="This reel's own captured sound -- click to seek"
        className="relative h-full cursor-pointer rounded-sm bg-amber-500"
        style={{ width: videoDurationSeconds * pixelsPerSecond }}
      >
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-black/30" />
        {secondTicks.map((second) => (
          <div
            key={second}
            className="pointer-events-none absolute top-1/2 h-2 w-px -translate-x-1/2 -translate-y-1/2 bg-black/40"
            style={{ left: second * pixelsPerSecond }}
          />
        ))}
      </div>
    </div>
  );
}
