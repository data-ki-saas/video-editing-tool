"use client";

/**
 * A one-second ruler shared by the whole synced-scroll timeline group
 * (FrameStrip, MainAudioTrackStrip, BackgroundTrackStrip) -- its own row at
 * the very bottom of the group, below BackgroundTrackStrip, rather than
 * drawn inside any one rail. It used to live inside MainAudioTrackStrip's
 * own rail (see that file's git history), but its tick labels sat right
 * under that rail's overlaid VolumeBadge (Playground.tsx's own module
 * comment) -- the two fought for the same pointer target when dragging the
 * playhead to the very start of the clip, near time 0. Pulling it out to its
 * own dedicated row keeps it out of every rail's own interactive/overlaid
 * area while still applying to all of them, since they all share the same
 * pixelsPerSecond scale and horizontal scroll position (see
 * lib/useSyncedHorizontalScroll.ts).
 *
 * Click-to-seek works here exactly like FrameStrip/MainAudioTrackStrip's own
 * click handler -- this row is part of the same shared timeline, so it
 * doubles as a seek control, same as the space it's replacing inside
 * MainAudioTrackStrip used to.
 *
 * Draws its own horizontal baseline (a literal x-axis line the ticks hang
 * down from) plus its own segment of the shared red playhead line -- every
 * rail above (FrameStrip, MainAudioTrackStrip, BackgroundTrackStrip) draws
 * that same line at the same `currentTimeSeconds * pixelsPerSecond` offset,
 * so stacked together they read as one continuous line down the whole
 * group. The axis line sits at this rail's own very top, so this rail's own
 * playhead segment (spanning its own full height, same as every other
 * rail's) starts right at the axis and visibly crosses it rather than
 * stopping flush with it.
 */
import { useRef } from "react";

export function TimeRulerStrip({
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
    return <div ref={scrollContainerRef} onScroll={onScroll} className="hide-scrollbar h-full overflow-x-auto bg-neutral-950 px-2" />;
  }

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (videoDurationSeconds <= 0 || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const fraction = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    onSeek(fraction * videoDurationSeconds);
  }

  // One tick per whole second, including a trailing tick for a
  // non-whole-second duration's final partial second -- same as this
  // strip's previous home inside MainAudioTrackStrip.
  const secondTicks = Array.from({ length: Math.floor(videoDurationSeconds) + 1 }, (_, second) => second);

  // Same pixel math every other synced rail's own playhead line uses --
  // see MainAudioTrackStrip's own comment on why this is a raw pixel
  // offset rather than a %.
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
        title="Timeline -- click to seek"
        className="relative h-full cursor-pointer"
        style={{ width: videoDurationSeconds * pixelsPerSecond }}
      >
        {/* The x-axis line itself -- ticks hang down from it. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/40" />
        {secondTicks.map((second) => (
          <div
            key={second}
            className="pointer-events-none absolute top-0 -translate-x-1/2"
            style={{ left: second * pixelsPerSecond }}
          >
            <div className="absolute top-0 h-1.5 w-px bg-white/30" />
            <div className="absolute top-2 whitespace-nowrap text-[8px] leading-none text-muted">{second}</div>
          </div>
        ))}
        <div
          className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-red-500"
          style={{ left: playheadLeftPx }}
        />
      </div>
    </div>
  );
}
