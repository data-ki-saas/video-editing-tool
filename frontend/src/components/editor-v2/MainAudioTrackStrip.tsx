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
 * other synced strips use, each tick labeled with its second number) gives
 * this rail a sense of elapsed time on its own, without needing to line it
 * up against FrameStrip's tiles to tell.
 *
 * `hide-scrollbar`, same as FrameStrip/BackgroundTrackStrip -- see
 * globals.css's own comment. Playground.tsx's own proxy scrollbar row, at
 * the very bottom of the whole synced group (below both audio rails), is
 * the one visible, draggable affordance; this rail still stays scrollable
 * via trackpad/wheel too.
 *
 * Click-to-seek works here exactly like FrameStrip's own click handler --
 * this rail is part of the same shared timeline, so scrubbing shouldn't
 * only work from the video frames above it. FrameStrip owns the
 * authoritative currentTimeSeconds/onSeek wiring (shared editor state), but
 * this rail draws its OWN red playhead line (at the exact same
 * `currentTimeSeconds * pixelsPerSecond` this file's own second-ticks use,
 * not FrameStrip's %-based one) plus a floating time ticker above it, so the
 * rail reads its own elapsed time without needing FrameStrip in view --
 * FrameStrip's tile widths are now sized so the two strips' total widths
 * (and therefore this same instant's pixel offset in each) agree exactly
 * (see FrameStrip's own module comment).
 */
import { useRef } from "react";

function formatTicker(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const mm = Math.floor(clamped / 60);
  const ss = clamped % 60;
  return `${mm}:${ss.toFixed(1).padStart(4, "0")}`;
}

export function MainAudioTrackStrip({
  videoDurationSeconds,
  pixelsPerSecond,
  currentTimeSeconds,
  onSeek,
  scrollContainerRef,
  onScroll,
}: {
  videoDurationSeconds: number;
  pixelsPerSecond: number;
  currentTimeSeconds: number;
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

  // Raw pixel offset (not a %) so this lines up exactly with secondTicks'
  // own `second * pixelsPerSecond` placement above, on this rail's own
  // exact-width track -- see this file's module comment.
  const playheadLeftPx = Math.min(Math.max(currentTimeSeconds, 0), videoDurationSeconds) * pixelsPerSecond;

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
            className="pointer-events-none absolute inset-y-0 -translate-x-1/2"
            style={{ left: second * pixelsPerSecond }}
          >
            <div className="absolute top-0 h-2 w-px bg-black/40" />
            <div className="absolute bottom-0 whitespace-nowrap text-[8px] leading-none text-black/70">{second}</div>
          </div>
        ))}
        <div
          className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-red-500"
          style={{ left: playheadLeftPx }}
        />
        <div
          className="pointer-events-none absolute bottom-full z-20 mb-1 -translate-x-1/2 whitespace-nowrap rounded-sm bg-black/80 px-1 text-[9px] leading-none text-white"
          style={{ left: playheadLeftPx }}
        >
          {formatTicker(currentTimeSeconds)}
        </div>
      </div>
    </div>
  );
}
