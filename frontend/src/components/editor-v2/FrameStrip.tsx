"use client";

/**
 * Renders the video "unfolded" into one thumbnail per second, and doubles
 * as a scrub timeline: click anywhere on the strip to seek CanvasPlayer to
 * that time, and a vertical playhead tracks playback position as it
 * advances (see ThreePaneEditor's currentTimeSeconds/onSeek wiring, and
 * CanvasPlayer's seekTo/onTimeUpdate).
 */
import { useRef } from "react";

export function FrameStrip({
  thumbnails,
  isLoading,
  durationSeconds,
  currentTimeSeconds,
  onSeek,
}: {
  thumbnails: string[];
  isLoading: boolean;
  durationSeconds: number;
  currentTimeSeconds: number;
  onSeek: (seconds: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  if (thumbnails.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 px-2 text-xs text-muted">
        {isLoading ? "Generating thumbnails…" : "Select a video to see its timeline"}
      </div>
    );
  }

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (durationSeconds <= 0 || !trackRef.current) return;
    // getBoundingClientRect() reflects the track's current rendered
    // position, scroll offset included -- clientX (a viewport coordinate)
    // minus rect.left is correct however far the strip has been scrolled.
    const rect = trackRef.current.getBoundingClientRect();
    const fraction = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    onSeek(fraction * durationSeconds);
  }

  const playheadPercent =
    durationSeconds > 0 ? Math.min(Math.max(currentTimeSeconds / durationSeconds, 0), 1) * 100 : 0;

  return (
    <div className="h-full overflow-x-auto bg-neutral-950 px-2">
      {/* w-max so this div's own width is the strip's true total length --
          the playhead's `left: %` below is relative to THIS box, not the
          (clipped, non-scrolling) outer container, so it stays aligned
          with the right thumbnail at any scroll position. */}
      <div ref={trackRef} onClick={handleClick} className="relative flex h-full w-max cursor-pointer items-center gap-1">
        {thumbnails.map((src, index) => (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived data URLs, not a Next-optimizable remote image
          <img
            key={index}
            src={src}
            alt={`Frame at ${index}s`}
            className="h-full w-auto shrink-0 rounded-sm object-cover"
          />
        ))}
        <div
          className="pointer-events-none absolute inset-y-0 w-0.5 bg-red-500"
          style={{ left: `${playheadPercent}%` }}
        />
      </div>
    </div>
  );
}
