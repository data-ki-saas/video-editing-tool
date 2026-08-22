"use client";

/**
 * Renders one bar per audio bucket, produced by lib/video/audio.ts's
 * extractVolumeProfile() (values already normalized 0..1 by
 * lib/video/video_math.ts's computeVolumeBuckets). Each bar is a fixed
 * `pixelsPerSecond` wide (one bucket = one second), matching FrameStrip's
 * per-thumbnail width and BackgroundTrackStrip's scale -- see
 * Playground.tsx's PIXELS_PER_SECOND and lib/useSyncedHorizontalScroll.ts
 * for why all three need to agree on that scale and share scroll position.
 */
export function VolumeGraph({
  levels,
  isLoading,
  pixelsPerSecond,
  scrollContainerRef,
  onScroll,
}: {
  levels: number[];
  isLoading: boolean;
  pixelsPerSecond: number;
  scrollContainerRef: (el: HTMLDivElement | null) => void;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
}) {
  if (levels.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-900 px-2 text-xs text-muted">
        {isLoading ? "Analyzing audio…" : "No audio to display yet"}
      </div>
    );
  }

  const MIN_BAR_HEIGHT_PERCENT = 2; // keeps near-silent buckets visible as a sliver, not invisible

  return (
    <div ref={scrollContainerRef} onScroll={onScroll} className="h-full overflow-x-auto bg-neutral-900 px-2 py-1">
      <div className="flex h-full w-max items-end">
        {levels.map((level, index) => (
          <div
            key={index}
            style={{ width: pixelsPerSecond, height: `${Math.max(MIN_BAR_HEIGHT_PERCENT, level * 100)}%` }}
            className="shrink-0 border-r border-neutral-900 bg-accent"
          />
        ))}
      </div>
    </div>
  );
}
