"use client";

/**
 * Visualizes the selected background track repeating (looping) across the
 * full duration of the video, as a strip of equal-width segments -- one per
 * loop -- shown above the frame thumbnail strip in the Playground. Empty
 * state when no track (or "None") is selected.
 *
 * Total width is `videoDurationSeconds * pixelsPerSecond` -- the same
 * scale FrameStrip and VolumeGraph use, so all three line up and share one
 * scroll position (see lib/useSyncedHorizontalScroll.ts).
 */
import { useEffect, useState } from "react";
import { BACKGROUND_TRACK_OPTIONS } from "@/lib/backgroundTracks";
import { getAudioDuration } from "@/lib/video/audio";

export function BackgroundTrackStrip({
  selectedTrackId,
  videoDurationSeconds,
  pixelsPerSecond,
  scrollContainerRef,
  onScroll,
}: {
  selectedTrackId: string;
  videoDurationSeconds: number;
  pixelsPerSecond: number;
  scrollContainerRef: (el: HTMLDivElement | null) => void;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
}) {
  const track = BACKGROUND_TRACK_OPTIONS.find((option) => option.id === selectedTrackId) ?? null;

  const [trackDurationSeconds, setTrackDurationSeconds] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null);
    if (!track?.url) {
      setTrackDurationSeconds(null);
      return;
    }

    let cancelled = false;
    getAudioDuration(track.url)
      .then((duration) => {
        if (!cancelled) setTrackDurationSeconds(duration);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load background track");
      });
    return () => {
      cancelled = true;
    };
  }, [track]);

  if (!track?.url) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-900 px-2 text-xs text-muted">
        No background track selected
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-900 px-2 text-xs text-red-400">{error}</div>
    );
  }
  if (!trackDurationSeconds || videoDurationSeconds <= 0) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-900 px-2 text-xs text-muted">Loading…</div>
    );
  }

  const loopCount = Math.max(1, Math.ceil(videoDurationSeconds / trackDurationSeconds));

  return (
    <div ref={scrollContainerRef} onScroll={onScroll} className="hide-scrollbar h-full overflow-x-auto bg-neutral-900 px-2 py-1">
      <div className="flex h-full gap-px" style={{ width: videoDurationSeconds * pixelsPerSecond }}>
        {Array.from({ length: loopCount }, (_, index) => {
          // The final loop is usually cut short by the video ending
          // mid-track -- its segment shrinks proportionally instead of
          // overhanging past the strip's right edge.
          const remainingSeconds = videoDurationSeconds - index * trackDurationSeconds;
          const widthFraction = Math.min(trackDurationSeconds, remainingSeconds) / videoDurationSeconds;
          return (
            <div
              key={index}
              style={{ flexBasis: `${widthFraction * 100}%` }}
              title={`${track.name} -- loop ${index + 1}`}
              className="shrink-0 rounded-sm border border-accent/40 bg-accent/20"
            />
          );
        })}
      </div>
    </div>
  );
}
